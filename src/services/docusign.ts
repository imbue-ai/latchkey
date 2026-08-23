/**
 * DocuSign connector: session-riding. The eSignature REST API needs an 8h BEARER (not
 * cookies), and the web SPA gets no refresh token -- so we can neither inject a cookie
 * (Slack-style) nor refresh over HTTP (OAuth-style). Instead we store the session cookies
 * and mint the bearer by loading the app with them and capturing the `Authorization:
 * Bearer` off the SPA's own calls. No password after first login; cookies last ~30 days.
 *
 * The mint needs a browser DocuSign does not block (a non-Chrome Chromium: Brave or a
 * stealth build). latchkey stays BYO-browser: `refreshCredentials` mints just-in-time only
 * when one is configured via `LATCHKEY_REFRESH_BROWSER_PATH`, else returns null and falls
 * back to an interactive re-login (~8h). eSignature calls go to
 * `{base_uri}/restapi/v2.1/accounts/{account_id}/...`; base_uri/account_id come from
 * `GET account.docusign.com/oauth/userinfo`.
 */

import type { Cookie, Response } from 'playwright';
import { loadPlaywright } from '../playwrightLoader.js';
import { z } from 'zod';
import { ApiCredentials, ApiCredentialsUsageError } from '../apiCredentials/base.js';
import {
  DEFAULT_ACCOUNT,
  fetchAccountFromEndpoint,
  tryParseJson,
} from '../apiCredentials/account.js';
import {
  isBrowserClosedError,
  type LoginResult,
  LoginCancelledError,
  LoginFailedError,
  Service,
  ServiceSession,
} from './core/base.js';

/** Where signing in starts. */
const DOCUSIGN_LOGIN_URL = 'https://account.docusign.com/';
const DOCUSIGN_USERINFO_URL = 'https://account.docusign.com/oauth/userinfo';

/** Host that means "signed in": the app shell (not the auth pages). */
const DOCUSIGN_APP_HOST = 'apps.docusign.com';

/**
 * The app home. Loading it makes the SPA authenticate from the stored cookies and fire
 * its own API calls; we capture the `Authorization: Bearer` off those calls.
 */
const DOCUSIGN_APP_HOME_URL = 'https://apps.docusign.com/send/home';

/** How long to wait for the SPA to fire an authenticated request / write a token. */
const MINT_POLL_ATTEMPTS = 30;
const MINT_POLL_INTERVAL_MS = 1000;
const LOGIN_TIMEOUT_MS = 300_000;

/**
 * Env var pointing at a non-Chrome Chromium (Brave or a stealth build) for the silent
 * refresh mint. Unset -> no silent refresh (fall back to interactive re-login).
 */
const REFRESH_BROWSER_PATH_ENV = 'LATCHKEY_REFRESH_BROWSER_PATH';

/**
 * Matches DocuSign's auth/userinfo host and every regional API host, so the bearer is
 * injected on both userinfo and the REST calls.
 */
const DOCUSIGN_BASE_API_URL_PATTERN =
  /^https:\/\/(account\.docusign\.com|[a-z0-9-]+\.docusign\.net)\//i;

/** A stored cookie, reduced to what Playwright's addCookies needs to restore it. */
const StoredCookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string(),
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
});
type StoredCookie = z.infer<typeof StoredCookieSchema>;

export const DocusignSessionCredentialsSchema = z.object({
  objectType: z.literal('docusign-session'),
  cookies: z.array(StoredCookieSchema),
  accessToken: z.string().optional(),
  accessTokenExpiresAt: z.string().optional(),
});
type DocusignSessionData = z.infer<typeof DocusignSessionCredentialsSchema>;

function toStoredCookies(cookies: readonly Cookie[]): StoredCookie[] {
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
  }));
}

/** Decode a JWT's `exp` (seconds since epoch) without verifying it. */
function jwtExpiry(token: string): number | undefined {
  const parts = token.split('.');
  const payloadPart = parts[1];
  if (payloadPart === undefined) {
    return undefined;
  }
  try {
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as {
      exp?: number;
    };
    return payload.exp;
  } catch {
    return undefined;
  }
}

/** ISO expiry for a captured token: its JWT `exp`, or 8h out if it cannot be decoded. */
function expiryIso(token: string): string {
  const exp = jwtExpiry(token);
  return new Date((exp ?? Math.floor(Date.now() / 1000) + 8 * 3600) * 1000).toISOString();
}

/**
 * DocuSign session credential: the web-session cookies plus the most recently minted
 * bearer. Injects the bearer; `isExpired` drives the re-mint in refreshCredentials.
 */
export class DocusignSessionCredentials implements ApiCredentials {
  readonly objectType = 'docusign-session' as const;

  constructor(
    readonly cookies: readonly StoredCookie[],
    readonly accessToken?: string,
    readonly accessTokenExpiresAt?: string
  ) {}

  injectIntoCurlCall(curlArguments: readonly string[]): Promise<readonly string[]> {
    if (this.accessToken === undefined) {
      throw new ApiCredentialsUsageError(
        'DocuSign credential has no access token yet. It is minted from the stored ' +
          'session on refresh.'
      );
    }
    return Promise.resolve(['-H', `Authorization: Bearer ${this.accessToken}`, ...curlArguments]);
  }

  isExpired(): boolean | undefined {
    if (this.accessTokenExpiresAt === undefined) {
      return true; // no token yet -> needs a mint
    }
    // Refresh a couple minutes early so an in-flight call never uses a dead token.
    return Date.now() >= new Date(this.accessTokenExpiresAt).getTime() - 120_000;
  }

  toJSON(): DocusignSessionData {
    return {
      objectType: this.objectType,
      cookies: [...this.cookies],
      accessToken: this.accessToken,
      accessTokenExpiresAt: this.accessTokenExpiresAt,
    };
  }

  static fromJSON(data: DocusignSessionData): DocusignSessionCredentials {
    return new DocusignSessionCredentials(
      data.cookies,
      data.accessToken,
      data.accessTokenExpiresAt
    );
  }
}

/** A DocuSign API host whose calls carry the bearer we want to capture. */
function isDocusignHost(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname;
    return host.endsWith('docusign.net') || host.endsWith('docusign.com');
  } catch {
    return false;
  }
}

/**
 * Mint a fresh bearer from the stored cookies by loading the app in `executablePath` (a
 * non-Chrome Chromium DocuSign does not block) and capturing the `Authorization: Bearer`
 * off the SPA's own API calls. No password. Returns a new credential with the captured
 * token and rotated cookies. Throws on failure; refreshCredentials turns that into null.
 */
async function mintFromSession(
  cookies: readonly StoredCookie[],
  executablePath: string
): Promise<DocusignSessionCredentials> {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  try {
    const context = await browser.newContext();
    await context.addCookies(cookies);

    let token: string | undefined;
    context.on('request', (request) => {
      if (token !== undefined) {
        return;
      }
      const auth = request.headers().authorization;
      if (auth === undefined || !/^bearer\s+ey/i.test(auth) || !isDocusignHost(request.url())) {
        return;
      }
      token = auth.slice(auth.indexOf(' ') + 1).trim();
    });

    const page = await context.newPage();
    await page.goto(DOCUSIGN_APP_HOME_URL, { waitUntil: 'domcontentloaded' });
    for (let attempt = 0; attempt < MINT_POLL_ATTEMPTS && token === undefined; attempt++) {
      await page.waitForTimeout(MINT_POLL_INTERVAL_MS);
    }
    if (token === undefined) {
      throw new LoginFailedError(
        'DocuSign session did not yield a token (cookies likely expired, or the browser ' +
          'was blocked as automation -- the user needs to sign in again).'
      );
    }

    const freshCookies = toStoredCookies(await context.cookies());
    return new DocusignSessionCredentials(freshCookies, token, expiryIso(token));
  } finally {
    await browser.close();
  }
}

/**
 * Browser login: the user signs into DocuSign once; we capture the session cookies and
 * the initial bearer. login() is overridden wholesale (like RampOAuthServiceSession)
 * because the stored credential is a session, not a response-scraped token.
 */
class DocusignSessionSession extends ServiceSession {
  onResponse(_response: Response): void {
    // Not used -- completion is detected by landing on the app host.
  }

  protected isLoginComplete(): boolean {
    return false; // login() is overridden entirely.
  }

  protected finalizeCredentials(): Promise<ApiCredentials | null> {
    return Promise.resolve(null); // login() is overridden entirely.
  }

  override async login(
    encryptedStorage: import('../encryptedStorage.js').EncryptedStorage,
    launchOptions: import('../playwrightUtils.js').BrowserLaunchOptions = {},
    _oldCredentials?: ApiCredentials
  ): Promise<LoginResult> {
    const { withTempBrowserContext } = await import('../playwrightUtils.js');

    return withTempBrowserContext(encryptedStorage, launchOptions, async ({ context }) => {
      const page = await context.newPage();
      try {
        await page.goto(DOCUSIGN_LOGIN_URL);

        // Wait for the user to finish signing in (works for password or SSO): the browser
        // lands on the app host once authenticated.
        await page.waitForURL((url) => url.hostname === DOCUSIGN_APP_HOST, {
          timeout: LOGIN_TIMEOUT_MS,
        });
        // Give the SPA a moment to write the initial token to localStorage.
        let token: string | undefined;
        for (let attempt = 0; attempt < MINT_POLL_ATTEMPTS; attempt++) {
          const authInfo = await page.evaluate<string | null>(
            "window.localStorage.getItem('@1ds/shell.auth_info')"
          );
          if (authInfo) {
            const parsed = tryParseJson(authInfo) as { access_token?: string } | null;
            if (parsed?.access_token) {
              token = parsed.access_token;
              break;
            }
          }
          await page.waitForTimeout(MINT_POLL_INTERVAL_MS);
        }

        const cookies = toStoredCookies(await context.cookies());
        const expiresAt = token !== undefined ? expiryIso(token) : undefined;
        const credentials = new DocusignSessionCredentials(cookies, token, expiresAt);
        const account = (await this.service.getAccount(credentials)) ?? DEFAULT_ACCOUNT;
        return { credentials, account };
      } catch (error: unknown) {
        if (error instanceof Error && isBrowserClosedError(error)) {
          throw new LoginCancelledError();
        }
        throw error;
      }
    });
  }
}

export class Docusign extends Service {
  readonly name = 'docusign';
  readonly displayName = 'DocuSign';
  readonly baseApiUrls = [DOCUSIGN_BASE_API_URL_PATTERN] as const;
  readonly loginUrl = DOCUSIGN_LOGIN_URL;
  readonly info =
    'DocuSign eSignature REST API. After login, GET ' +
    'https://account.docusign.com/oauth/userinfo to read your account_id and base_uri ' +
    '(the regional host, e.g. https://na4.docusign.net); then call ' +
    '{base_uri}/restapi/v2.1/accounts/{account_id}/... To send a contract for signature, ' +
    'POST an envelope with status "sent". ' +
    'Do NOT set up a DocuSign integration key, OAuth app, or go-live -- that developer ' +
    'path is gated behind payment and review and is not needed here: this connector ' +
    'already authenticates via the browser session, so just call the REST API directly. ' +
    'The gateway re-mints the 8h bearer from the stored session, so no re-login until ' +
    'the session expires.';

  // userinfo returns 200 for any valid token, so it doubles as the credential check.
  readonly credentialCheckCurlArguments = [DOCUSIGN_USERINFO_URL] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth browser ${serviceName}`;
  }

  override getAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    return fetchAccountFromEndpoint(apiCredentials, [DOCUSIGN_USERINFO_URL], (responseBody) => {
      const data = tryParseJson(responseBody) as { email?: string; sub?: string } | null;
      return data?.email ?? data?.sub ?? null;
    });
  }

  override getSession(appNamePrefix: string): DocusignSessionSession {
    return new DocusignSessionSession(this, appNamePrefix);
  }

  /**
   * Re-mint the 8h bearer from the stored session cookies (no password), just in time.
   * Needs a non-Chrome Chromium via `LATCHKEY_REFRESH_BROWSER_PATH`; without it, returns
   * null so latchkey falls back to an interactive re-login. Returns null (never throws):
   * a thrown error here breaks callers like `services info` and the approval prompt.
   */
  override async refreshCredentials(
    apiCredentials: ApiCredentials
  ): Promise<ApiCredentials | null> {
    if (!(apiCredentials instanceof DocusignSessionCredentials)) {
      return null;
    }
    if (apiCredentials.cookies.length === 0) {
      return null;
    }
    const refreshBrowser = process.env[REFRESH_BROWSER_PATH_ENV];
    if (refreshBrowser === undefined || refreshBrowser.length === 0) {
      // No refresh browser configured -> no silent mint; degrade to interactive re-login.
      return null;
    }
    try {
      return await mintFromSession(apiCredentials.cookies, refreshBrowser);
    } catch {
      return null;
    }
  }
}

export const DOCUSIGN = new Docusign();
