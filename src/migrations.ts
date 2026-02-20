import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import type { EncryptedStorage } from './encryptedStorage.js';

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

const DATA_FORMAT_VERSION_FILENAME = 'data-format-version';

type MigrationFunction = (config: Config, encryptedStorage: EncryptedStorage) => void;

const GOOGLE_OAUTH_SERVICE_NAMES = [
  'google-gmail',
  'google-calendar',
  'google-drive',
  'google-sheets',
  'google-docs',
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

const MIGRATIONS: readonly MigrationFunction[] = [migrationSplitGoogleCredentials];

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
  writeFileSync(versionFilePath, String(version), 'utf-8');
}

function isFirstInstallation(config: Config): boolean {
  return !existsSync(config.directory) || !existsSync(config.credentialStorePath);
}

export function runMigrations(config: Config, encryptedStorage: EncryptedStorage): void {
  if (isFirstInstallation(config)) {
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
    migration(config, encryptedStorage);
  }

  if (currentVersion < LATEST_VERSION) {
    writeDataFormatVersion(config, LATEST_VERSION);
  }
}
