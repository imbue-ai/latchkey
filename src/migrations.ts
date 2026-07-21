import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomicWrite.js';
import { DEFAULT_ACCOUNT } from './apiCredentials/account.js';
import { ApiCredentialStatus } from './apiCredentials/base.js';
import { ApiCredentialsSchema, deserializeCredentials } from './apiCredentials/serialization.js';
import type { Config } from './config.js';
import type { EncryptedStorage } from './encryptedStorage.js';
import { SERVICE_REGISTRY } from './serviceRegistry.js';

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

const DATA_FORMAT_VERSION_FILENAME = 'data-format-version';

/**
 * The resolved validity and owning account of a service's stored credentials.
 * The account is null when it cannot be determined.
 */
export interface ResolvedCredential {
  readonly status: ApiCredentialStatus;
  readonly account: string | null;
}

/**
 * Resolves the validity and owning account of a service's stored credentials.
 * Injected into migrations so tests can dictate check outcomes directly
 * instead of stubbing the service registry and the curl subprocess layer.
 *
 * A resolver must be best-effort: it should never reject. Anything it cannot
 * determine (unknown service, unparseable data, network error, timeout) is
 * reported as {@link ApiCredentialStatus.Unknown} so the migration leaves the
 * default account in place rather than dropping credentials.
 */
export type CredentialResolver = (
  serviceName: string,
  credentialData: unknown
) => Promise<ResolvedCredential>;

/**
 * Default resolver: look the service up in the registry, ask it to check the
 * credentials and — when they are valid — which account they belong to,
 * translating every failure mode into an inconclusive result.
 */
async function resolveCredentialViaServiceRegistry(
  serviceName: string,
  credentialData: unknown
): Promise<ResolvedCredential> {
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
    const status = await service.checkApiCredentials(credentials);
    const account =
      status === ApiCredentialStatus.Valid ? await service.getAccount(credentials) : null;
    return { status, account };
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
 * Convert the pre-multi-account format `{ service: credentials }` into the
 * account-keyed store with separate preparations:
 * `{ credentials: { service: { account: credentials } }, preparations: { service: oauthClient } }`.
 *
 * For every service, the stored credentials are validated in parallel:
 *   - valid credentials whose account can be determined are keyed by that
 *     account instead of the default one,
 *   - valid credentials whose account cannot be determined stay under the
 *     default account,
 *   - definitively invalid credentials are dropped,
 *   - anything inconclusive (unknown service, network error, timeout) is left
 *     under the default account (best-effort).
 *
 * Independently of validity, the OAuth client (id/secret) of every OAuth
 * credential entry is saved as a preparation, so that future logins — also to
 * additional accounts — can reuse the client without a fresh browser-prepare.
 * This deliberately includes dropped invalid credentials (an expired token
 * says nothing about the client) and the token-less placeholders that `auth
 * prepare` / `auth browser-prepare` used to store as credentials; the
 * placeholders live on only as preparations.
 */
async function migrationIntroduceAccountsAndPreparations(
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
    Object.entries(store).map(async ([serviceName, credentialData]) => ({
      serviceName,
      credentialData,
      check: await resolveCredential(serviceName, credentialData),
    }))
  );

  const credentials: Record<string, Record<string, unknown>> = {};
  const preparations: Record<string, unknown> = {};

  for (const { serviceName, credentialData, check } of resolvedEntries) {
    const oauthData = asOAuthCredentialData(credentialData);
    if (oauthData !== null && oauthData.clientId !== '') {
      preparations[serviceName] = {
        objectType: 'oauth',
        clientId: oauthData.clientId,
        clientSecret: oauthData.clientSecret,
      };
    }

    const isPreparedPlaceholder = oauthData !== null && oauthData.accessToken === undefined;
    if (isPreparedPlaceholder || check.status === ApiCredentialStatus.Invalid) {
      continue;
    }

    const account =
      check.status === ApiCredentialStatus.Valid &&
      check.account !== null &&
      check.account !== DEFAULT_ACCOUNT
        ? check.account
        : DEFAULT_ACCOUNT;
    credentials[serviceName] = { [account]: credentialData };
  }

  encryptedStorage.writeFile(
    config.credentialStorePath,
    JSON.stringify({ credentials, preparations }, null, 2)
  );
}

const MIGRATIONS: readonly MigrationFunction[] = [
  migrationSplitGoogleCredentials,
  migrationIntroduceAccountsAndPreparations,
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
