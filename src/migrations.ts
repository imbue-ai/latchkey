import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomicWrite.js';
import { DEFAULT_ACCOUNT } from './apiCredentials/account.js';
import { ApiCredentialStatus } from './apiCredentials/base.js';
import {
  ApiCredentialsSchema,
  deserializeCredentials,
} from './apiCredentials/serialization.js';
import type { Config } from './config.js';
import type { EncryptedStorage } from './encryptedStorage.js';
import { SERVICE_REGISTRY } from './serviceRegistry.js';
import type { CredentialCheck } from './services/core/base.js';

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

const DATA_FORMAT_VERSION_FILENAME = 'data-format-version';

/**
 * Resolves the validity and owning account of a service's stored credentials.
 * Injected into migrations so tests can avoid real network calls.
 *
 * A resolver must be best-effort: it should never reject. Anything it cannot
 * determine (unknown service, unparseable data, network error, timeout) is
 * reported as {@link ApiCredentialStatus.Unknown} so the migration leaves the
 * default account in place rather than dropping credentials.
 */
export type CredentialResolver = (
  serviceName: string,
  credentialData: unknown
) => Promise<CredentialCheck>;

/**
 * Default resolver: look the service up in the registry and ask it to check the
 * credentials, translating every failure mode into an inconclusive result.
 */
async function resolveCredentialViaServiceRegistry(
  serviceName: string,
  credentialData: unknown
): Promise<CredentialCheck> {
  const service = SERVICE_REGISTRY.getByName(serviceName);
  if (service === null) {
    return { status: ApiCredentialStatus.Unknown, account: null };
  }

  const parsed = ApiCredentialsSchema.safeParse(credentialData);
  if (!parsed.success) {
    return { status: ApiCredentialStatus.Unknown, account: null };
  }

  try {
    const credentials = deserializeCredentials(parsed.data);
    return await service.checkApiCredentials(credentials);
  } catch {
    return { status: ApiCredentialStatus.Unknown, account: null };
  }
}

type MigrationFunction = (
  config: Config,
  encryptedStorage: EncryptedStorage,
  resolveCredential: CredentialResolver
) => void | Promise<void>;

const GOOGLE_OAUTH_SERVICE_NAMES = [
  'google-gmail',
  'google-calendar',
  'google-drive',
  'google-sheets',
  'google-docs',
  'google-slides',
  'google-people',
] as const;

function migrationSplitGoogleCredentials(config: Config, encryptedStorage: EncryptedStorage): void {
  const content = encryptedStorage.readFile(config.credentialStorePath);
  if (content === null) {
    return;
  }

  const store = JSON.parse(content) as Record<string, unknown>;
  if (!('google' in store)) {
    return;
  }

  const googleCredentials = store.google;
  const { google: _, ...rest } = store;

  for (const serviceName of GOOGLE_OAUTH_SERVICE_NAMES) {
    if (!(serviceName in rest)) {
      rest[serviceName] = googleCredentials;
    }
  }

  encryptedStorage.writeFile(config.credentialStorePath, JSON.stringify(rest, null, 2));
}

/**
 * Wrap each service's credentials in an account-keyed dictionary. Converts the
 * pre-multi-account format `{ service: credentials }` into
 * `{ service: { account: credentials } }`.
 *
 * For every service, the stored credentials are validated in parallel:
 *   - valid credentials whose account can be determined are keyed by that
 *     account instead of the default one,
 *   - valid credentials whose account cannot be determined stay under the
 *     default account,
 *   - definitively invalid credentials are dropped,
 *   - anything inconclusive (unknown service, network error, timeout) is left
 *     under the default account (best-effort).
 */
async function migrationIntroduceAccounts(
  config: Config,
  encryptedStorage: EncryptedStorage,
  resolveCredential: CredentialResolver
): Promise<void> {
  const content = encryptedStorage.readFile(config.credentialStorePath);
  if (content === null) {
    return;
  }

  const store = JSON.parse(content) as Record<string, unknown>;

  const resolvedEntries = await Promise.all(
    Object.entries(store).map(async ([serviceName, credentials]) => ({
      serviceName,
      credentials,
      check: await resolveCredential(serviceName, credentials),
    }))
  );

  const migrated: Record<string, Record<string, unknown>> = {};
  for (const { serviceName, credentials, check } of resolvedEntries) {
    if (check.status === ApiCredentialStatus.Invalid) {
      continue;
    }
    const account =
      check.status === ApiCredentialStatus.Valid &&
      check.account !== null &&
      check.account !== DEFAULT_ACCOUNT
        ? check.account
        : DEFAULT_ACCOUNT;
    migrated[serviceName] = { [account]: credentials };
  }

  encryptedStorage.writeFile(config.credentialStorePath, JSON.stringify(migrated, null, 2));
}

/**
 * The serialized shape of an OAuth credential entry, as far as this migration
 * needs it: the client pair plus the access token whose absence marks the
 * entry as "prepared but not yet logged in".
 */
interface OAuthCredentialData {
  readonly objectType: 'oauth';
  readonly clientId: string;
  readonly clientSecret: string;
  readonly accessToken?: string;
}

function asOAuthCredentialData(credentialData: unknown): OAuthCredentialData | null {
  if (typeof credentialData !== 'object' || credentialData === null) {
    return null;
  }
  const record = credentialData as Record<string, unknown>;
  if (
    record.objectType !== 'oauth' ||
    typeof record.clientId !== 'string' ||
    typeof record.clientSecret !== 'string'
  ) {
    return null;
  }
  return record as unknown as OAuthCredentialData;
}

/**
 * Split the store into the two top-level sections "credentials" and
 * "preparations". Converts `{ service: { account: credentials } }` into
 * `{ credentials: { service: { account: credentials } }, preparations: { service: credentials } }`.
 *
 * Preparations are populated from two sources:
 *   - a token-less OAuth client under the default account is the placeholder
 *     that `auth prepare` / `auth browser-prepare` used to create; it is moved
 *     out of the credentials section into preparations,
 *   - otherwise, for every service with complete OAuth credentials (e.g. the
 *     Google services), a token-less copy of the client id/secret is derived
 *     so that future logins to additional accounts can reuse the client
 *     without a fresh browser-prepare.
 */
function migrationSeparatePreparations(config: Config, encryptedStorage: EncryptedStorage): void {
  const content = encryptedStorage.readFile(config.credentialStorePath);
  if (content === null) {
    return;
  }

  const store = JSON.parse(content) as Record<string, Record<string, unknown>>;

  const credentials: Record<string, Record<string, unknown>> = {};
  const preparations: Record<string, unknown> = {};

  for (const [serviceName, accountMap] of Object.entries(store)) {
    const remainingAccounts: Record<string, unknown> = {};
    for (const [account, credentialData] of Object.entries(accountMap)) {
      const oauthData = asOAuthCredentialData(credentialData);
      const isPreparedPlaceholder =
        account === DEFAULT_ACCOUNT && oauthData !== null && oauthData.accessToken === undefined;
      if (isPreparedPlaceholder) {
        preparations[serviceName] = credentialData;
      } else {
        remainingAccounts[account] = credentialData;
      }
    }
    if (Object.keys(remainingAccounts).length > 0) {
      credentials[serviceName] = remainingAccounts;
    }
  }

  for (const [serviceName, accountMap] of Object.entries(credentials)) {
    if (serviceName in preparations) {
      continue;
    }
    // Prefer the default account's client, matching the account preference the
    // pre-preparations login flow used when reusing stored credentials.
    const orderedEntries = Object.values({
      [DEFAULT_ACCOUNT]: accountMap[DEFAULT_ACCOUNT],
      ...accountMap,
    });
    const oauthData = orderedEntries
      .map(asOAuthCredentialData)
      .find((candidate) => candidate !== null && candidate.clientId !== '');
    if (oauthData !== null && oauthData !== undefined) {
      preparations[serviceName] = {
        objectType: 'oauth',
        clientId: oauthData.clientId,
        clientSecret: oauthData.clientSecret,
      };
    }
  }

  encryptedStorage.writeFile(
    config.credentialStorePath,
    JSON.stringify({ credentials, preparations }, null, 2)
  );
}

const MIGRATIONS: readonly MigrationFunction[] = [
  migrationSplitGoogleCredentials,
  migrationIntroduceAccounts,
  migrationSeparatePreparations,
];

export const LATEST_VERSION = MIGRATIONS.length;

export function readDataFormatVersion(config: Config): number {
  const versionFilePath = join(config.directory, DATA_FORMAT_VERSION_FILENAME);
  if (!existsSync(versionFilePath)) {
    return 0;
  }
  const content = readFileSync(versionFilePath, 'utf-8').trim();
  const version = Number(content);
  if (!Number.isInteger(version) || version < 0) {
    throw new MigrationError(
      `Invalid data format version: '${content}'. Expected a non-negative integer.`
    );
  }
  return version;
}

function writeDataFormatVersion(config: Config, version: number): void {
  const versionFilePath = join(config.directory, DATA_FORMAT_VERSION_FILENAME);
  writeFileAtomic(versionFilePath, String(version));
}

function isFirstInstallation(config: Config): boolean {
  return !existsSync(config.directory) || !existsSync(config.credentialStorePath);
}

export async function runMigrations(
  config: Config,
  encryptedStorage: EncryptedStorage,
  resolveCredential: CredentialResolver = resolveCredentialViaServiceRegistry
): Promise<void> {
  if (isFirstInstallation(config)) {
    // A fresh installation starts out in the newest data format. Stamp the
    // version right away so that a later run does not mistake the newly
    // created store for one in the oldest format and "migrate" (i.e. corrupt)
    // it.
    mkdirSync(config.directory, { recursive: true, mode: 0o700 });
    writeDataFormatVersion(config, LATEST_VERSION);
    return;
  }

  const currentVersion = readDataFormatVersion(config);

  if (currentVersion > LATEST_VERSION) {
    throw new MigrationError(
      `Data format version ${String(currentVersion)} is newer than the latest supported version ${String(LATEST_VERSION)}. ` +
        'Please upgrade latchkey.'
    );
  }

  for (let i = currentVersion; i < LATEST_VERSION; i++) {
    const migration = MIGRATIONS[i];
    if (migration === undefined) {
      throw new MigrationError(`Missing migration function for version ${String(i + 1)}.`);
    }
    await migration(config, encryptedStorage, resolveCredential);
  }

  if (currentVersion < LATEST_VERSION) {
    writeDataFormatVersion(config, LATEST_VERSION);
  }
}
