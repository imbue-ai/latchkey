/**
 * Import cookies (and the localStorage of the services Latchkey knows) from the
 * user's regular Google Chrome profile into Latchkey's encrypted browser state,
 * so that browser flows start out logged in.
 *
 * The parts of the profile that hold this data are copied to a temporary
 * location first: Chrome refuses to be automated on its default user data
 * directory, and it would clash with a Chrome instance the user may have
 * running.
 */

import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import type { EncryptedStorage } from './encryptedStorage.js';
import { loadPlaywright } from './playwrightLoader.js';
import type { Service } from './services/index.js';

export class ChromeNotFoundError extends Error {
  constructor() {
    super('Google Chrome is not installed in any of the standard locations.');
    this.name = 'ChromeNotFoundError';
  }
}

export class ChromeProfileNotFoundError extends Error {
  constructor(profilePath: string) {
    super(`No default Google Chrome profile found at ${profilePath}.`);
    this.name = 'ChromeProfileNotFoundError';
  }
}

export class ChromeProfileTooLargeError extends Error {
  constructor(sizeInBytes: number, limitInBytes: number) {
    const toMebibytes = (bytes: number) => String(Math.round(bytes / 1024 / 1024));
    super(
      `The Google Chrome profile data to copy takes ${toMebibytes(sizeInBytes)} MiB, ` +
        `more than the limit of ${toMebibytes(limitInBytes)} MiB.`
    );
    this.name = 'ChromeProfileTooLargeError';
  }
}

export class InvalidBrowserStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBrowserStateError';
  }
}

export type BrowserStorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

type Cookie = BrowserStorageState['cookies'][number];

type OriginStorage = BrowserStorageState['origins'][number];

const DEFAULT_PROFILE_DIRECTORY_NAME = 'Default';

/**
 * What gets copied, relative to the user data directory. The rest of it (caches,
 * on-device models, ...) can be huge and is not needed to read cookies and
 * localStorage. Paths that do not exist are skipped.
 */
const COPIED_USER_DATA_PATHS: readonly string[] = [
  // Holds the key cookies are encrypted with on Windows.
  'Local State',
  `${DEFAULT_PROFILE_DIRECTORY_NAME}/Network/Cookies`,
  `${DEFAULT_PROFILE_DIRECTORY_NAME}/Network/Cookies-journal`,
  // Where cookies lived before Chrome 96.
  `${DEFAULT_PROFILE_DIRECTORY_NAME}/Cookies`,
  `${DEFAULT_PROFILE_DIRECTORY_NAME}/Cookies-journal`,
  `${DEFAULT_PROFILE_DIRECTORY_NAME}/Local Storage`,
];

/**
 * Google Chrome specifically (not Chromium or Edge): the copied cookies can only
 * be decrypted by the browser whose OS keychain entry they were encrypted with.
 */
function chromeExecutableCandidates(): readonly string[] {
  switch (platform()) {
    case 'darwin':
      return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
    case 'linux':
      return [
        '/opt/google/chrome/chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
      ];
    case 'win32':
      return [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
        .filter((prefix): prefix is string => prefix !== undefined && prefix !== '')
        .map((prefix) => join(prefix, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    default:
      return [];
  }
}

export function findChromeExecutable(): string | null {
  return chromeExecutableCandidates().find((candidate) => existsSync(candidate)) ?? null;
}

export function getChromeUserDataDirectory(): string {
  switch (platform()) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
    case 'win32':
      return join(
        process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
        'Google',
        'Chrome',
        'User Data'
      );
    default: {
      const configHome = process.env.XDG_CONFIG_HOME;
      return join(
        configHome !== undefined && configHome !== '' ? configHome : join(homedir(), '.config'),
        'google-chrome'
      );
    }
  }
}

/** The distinct web origins of the services' login URLs. */
export function collectLoginOrigins(services: readonly Service[]): readonly string[] {
  const origins = services
    .filter((service) => URL.canParse(service.loginUrl))
    .map((service) => new URL(service.loginUrl))
    .filter((url) => url.protocol === 'https:' || url.protocol === 'http:')
    .map((url) => url.origin);
  return [...new Set(origins)].sort();
}

function cookieKey(cookie: Cookie): string {
  return JSON.stringify([cookie.name, cookie.domain, cookie.path]);
}

/**
 * Combine two storage states. Where both have the same cookie (by name, domain
 * and path) or the same origin, the imported one wins.
 */
export function mergeBrowserStorageStates(
  existing: BrowserStorageState,
  imported: BrowserStorageState
): BrowserStorageState {
  const cookies = new Map<string, Cookie>();
  for (const cookie of [...existing.cookies, ...imported.cookies]) {
    cookies.set(cookieKey(cookie), cookie);
  }
  const origins = new Map<string, OriginStorage>();
  for (const origin of [...existing.origins, ...imported.origins]) {
    origins.set(origin.origin, origin);
  }
  return { cookies: [...cookies.values()], origins: [...origins.values()] };
}

export function parseBrowserStorageState(content: string): BrowserStorageState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new InvalidBrowserStateError('The stored browser state is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new InvalidBrowserStateError('The stored browser state is not a JSON object.');
  }
  const { cookies, origins } = parsed as Partial<Record<keyof BrowserStorageState, unknown>>;
  return {
    cookies: Array.isArray(cookies) ? (cookies as Cookie[]) : [],
    origins: Array.isArray(origins) ? (origins as OriginStorage[]) : [],
  };
}

/**
 * Sanity limit on how much gets copied. The copied data is normally a few
 * megabytes; anything near this means something unexpected is in there.
 */
const MAXIMUM_COPY_SIZE_IN_BYTES = 1024 * 1024 * 1024;

function measureSizeInBytes(path: string): number {
  const stats = statSync(path);
  if (!stats.isDirectory()) {
    return stats.size;
  }
  return readdirSync(path)
    .map((entry) => measureSizeInBytes(join(path, entry)))
    .reduce((total, size) => total + size, 0);
}

/** Total size of what {@link copyDefaultProfile} would copy. */
export function measureCopiedUserDataSizeInBytes(chromeUserDataDirectory: string): number {
  return COPIED_USER_DATA_PATHS.map((relativePath) => join(chromeUserDataDirectory, relativePath))
    .filter((path) => existsSync(path))
    .map(measureSizeInBytes)
    .reduce((total, size) => total + size, 0);
}

/**
 * Copy the cookies and localStorage of the default profile into a fresh user
 * data directory and return its path.
 */
function copyDefaultProfile(chromeUserDataDirectory: string): string {
  const profileDirectory = join(chromeUserDataDirectory, DEFAULT_PROFILE_DIRECTORY_NAME);
  if (!existsSync(profileDirectory)) {
    throw new ChromeProfileNotFoundError(profileDirectory);
  }
  const copySizeInBytes = measureCopiedUserDataSizeInBytes(chromeUserDataDirectory);
  if (copySizeInBytes > MAXIMUM_COPY_SIZE_IN_BYTES) {
    throw new ChromeProfileTooLargeError(copySizeInBytes, MAXIMUM_COPY_SIZE_IN_BYTES);
  }
  const temporaryUserDataDirectory = mkdtempSync(join(tmpdir(), 'latchkey-chrome-profile-'));
  for (const relativePath of COPIED_USER_DATA_PATHS) {
    const source = join(chromeUserDataDirectory, relativePath);
    if (existsSync(source)) {
      cpSync(source, join(temporaryUserDataDirectory, relativePath), { recursive: true });
    }
  }
  return temporaryUserDataDirectory;
}

/**
 * Read the localStorage of the given origins. Every request is answered with an
 * empty page, so each origin is visited without any network traffic or site
 * scripts, and what is read is exactly what the profile has stored.
 */
async function readLocalStorage(
  context: BrowserContext,
  origins: readonly string[]
): Promise<readonly OriginStorage[]> {
  await context.route('**/*', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '' })
  );
  const page = await context.newPage();
  try {
    const originStorages: OriginStorage[] = [];
    for (const origin of origins) {
      await page.goto(origin);
      const entries = await page.evaluate<[string, string][]>(
        'Object.entries(window.localStorage)'
      );
      if (entries.length > 0) {
        originStorages.push({
          origin,
          localStorage: entries.map(([name, value]) => ({ name, value })),
        });
      }
    }
    return originStorages;
  } finally {
    await page.close();
  }
}

async function readChromeProfileStorageState(
  chromeExecutablePath: string,
  userDataDirectory: string,
  localStorageOrigins: readonly string[]
): Promise<BrowserStorageState> {
  const { chromium } = await loadPlaywright();
  const context = await chromium.launchPersistentContext(userDataDirectory, {
    executablePath: chromeExecutablePath,
    headless: true,
    args: [`--profile-directory=${DEFAULT_PROFILE_DIRECTORY_NAME}`],
    // Playwright's defaults keep Chrome away from the OS keychain, which holds
    // the key needed to decrypt the copied cookies.
    ignoreDefaultArgs: ['--password-store=basic', '--use-mock-keychain', '--enable-automation'],
    // A service worker from the profile could otherwise answer instead of the
    // route that keeps the origin visits offline.
    serviceWorkers: 'block',
  });
  try {
    const cookies = await context.cookies();
    const origins = await readLocalStorage(context, localStorageOrigins);
    return { cookies, origins: [...origins] };
  } finally {
    await context.close();
  }
}

export interface BrowserStateImportResult {
  readonly importedCookieCount: number;
  /** Origins (among those asked for) that had localStorage to import. */
  readonly importedLocalStorageOrigins: readonly string[];
}

/**
 * Read the cookies of the user's default Chrome profile, and the localStorage
 * of `localStorageOrigins`, and merge them into the encrypted browser state at
 * `browserStatePath`.
 */
export async function importChromeBrowserState(
  encryptedStorage: EncryptedStorage,
  browserStatePath: string,
  localStorageOrigins: readonly string[]
): Promise<BrowserStateImportResult> {
  const chromeExecutablePath = findChromeExecutable();
  if (chromeExecutablePath === null) {
    throw new ChromeNotFoundError();
  }

  const temporaryUserDataDirectory = copyDefaultProfile(getChromeUserDataDirectory());
  let importedState: BrowserStorageState;
  try {
    importedState = await readChromeProfileStorageState(
      chromeExecutablePath,
      temporaryUserDataDirectory,
      localStorageOrigins
    );
  } finally {
    rmSync(temporaryUserDataDirectory, { recursive: true, force: true });
  }

  // Read only now, right before writing, so that changes other processes made
  // to the browser state while Chrome was running are not overwritten.
  const existingContent = encryptedStorage.readFile(browserStatePath);
  const existingState =
    existingContent === null
      ? { cookies: [], origins: [] }
      : parseBrowserStorageState(existingContent);
  const mergedState = mergeBrowserStorageStates(existingState, importedState);
  encryptedStorage.writeFile(browserStatePath, JSON.stringify(mergedState, null, 2));
  return {
    importedCookieCount: importedState.cookies.length,
    importedLocalStorageOrigins: importedState.origins.map((origin) => origin.origin),
  };
}
