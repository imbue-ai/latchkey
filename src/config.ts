/**
 * Configuration management for Latchkey.
 */

import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

export class InsecureFilePermissionsError extends Error {
  constructor(filePath: string, permissions: number) {
    const permissionsOctal = permissions.toString(8).padStart(3, '0');
    super(
      `File ${filePath} has insecure permissions (${permissionsOctal}). Run: chmod 600 ${filePath}`
    );
    this.name = 'InsecureFilePermissionsError';
  }
}

export class CurlNotFoundError extends Error {
  constructor(curlCommand: string) {
    super(`'${curlCommand}' is not available. Please install curl.`);
    this.name = 'CurlNotFoundError';
  }
}

const LATCHKEY_DIRECTORY_ENV_VAR = 'LATCHKEY_DIRECTORY';
const LATCHKEY_CURL_ENV_VAR = 'LATCHKEY_CURL';
const LATCHKEY_ENCRYPTION_KEY_ENV_VAR = 'LATCHKEY_ENCRYPTION_KEY';
const LATCHKEY_KEYRING_SERVICE_NAME_ENV_VAR = 'LATCHKEY_KEYRING_SERVICE_NAME';
const LATCHKEY_KEYRING_ACCOUNT_NAME_ENV_VAR = 'LATCHKEY_KEYRING_ACCOUNT_NAME';
const LATCHKEY_DISABLE_BROWSER_ENV_VAR = 'LATCHKEY_DISABLE_BROWSER';

export const DEFAULT_KEYRING_SERVICE_NAME = 'latchkey';
export const DEFAULT_KEYRING_ACCOUNT_NAME = 'encryption-key';

const DEFAULT_DIRECTORY = join(homedir(), '.latchkey');

const CREDENTIAL_STORE_FILENAME = 'credentials.json.enc';
const BROWSER_STATE_FILENAME = 'browser_state.json.enc';
const CONFIG_FILENAME = 'config.json';

function resolvePathWithTildeExpansion(path: string): string {
  if (path.startsWith('~')) {
    return resolve(homedir(), path.slice(2));
  }
  return resolve(path);
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findInPath(command: string): boolean {
  if (isAbsolute(command)) {
    return isExecutable(command);
  }

  const pathEnv = process.env.PATH ?? '';
  const pathDirs = pathEnv.split(delimiter);

  for (const dir of pathDirs) {
    const fullPath = join(dir, command);
    if (isExecutable(fullPath)) {
      return true;
    }
  }

  return false;
}

/**
 * Configuration for Latchkey, sourced from environment variables with sensible defaults.
 */
export class Config {
  readonly directory: string;
  readonly credentialStorePath: string;
  readonly browserStatePath: string;
  readonly configPath: string;
  readonly curlCommand: string;
  /**
   * Encryption key override from environment variable.
   * If set, this key will be used instead of the system keychain.
   * The key should be a base64-encoded 256-bit (32-byte) value.
   */
  readonly encryptionKeyOverride: string | null;
  readonly serviceName: string;
  readonly accountName: string;
  /**
   * When true, the browser login flow is disabled.
   * Commands that require browser login will fail with an error.
   */
  readonly browserDisabled: boolean;

  constructor(getEnv: (name: string) => string | undefined = (name) => process.env[name]) {
    this.curlCommand = getEnv(LATCHKEY_CURL_ENV_VAR) ?? 'curl';
    this.encryptionKeyOverride = getEnv(LATCHKEY_ENCRYPTION_KEY_ENV_VAR) ?? null;
    this.serviceName =
      getEnv(LATCHKEY_KEYRING_SERVICE_NAME_ENV_VAR) ?? DEFAULT_KEYRING_SERVICE_NAME;
    this.accountName =
      getEnv(LATCHKEY_KEYRING_ACCOUNT_NAME_ENV_VAR) ?? DEFAULT_KEYRING_ACCOUNT_NAME;

    const browserDisabledEnv = getEnv(LATCHKEY_DISABLE_BROWSER_ENV_VAR);
    this.browserDisabled = browserDisabledEnv !== undefined && browserDisabledEnv !== '';

    const directoryEnv = getEnv(LATCHKEY_DIRECTORY_ENV_VAR);
    this.directory = directoryEnv ? resolvePathWithTildeExpansion(directoryEnv) : DEFAULT_DIRECTORY;

    this.credentialStorePath = join(this.directory, CREDENTIAL_STORE_FILENAME);
    this.browserStatePath = join(this.directory, BROWSER_STATE_FILENAME);
    this.configPath = join(this.directory, CONFIG_FILENAME);
  }

  /**
   * Check that sensitive files have secure permissions.
   * Throws InsecureFilePermissionsError if any file is readable by group or others.
   */
  checkSensitiveFilePermissions(): void {
    const filesToCheck = [this.credentialStorePath, this.browserStatePath];

    for (const filePath of filesToCheck) {
      if (!existsSync(filePath)) {
        continue;
      }

      const stats = statSync(filePath);
      if (stats.isDirectory()) {
        continue;
      }

      const permissions = stats.mode & 0o777;
      if ((permissions & 0o077) !== 0) {
        throw new InsecureFilePermissionsError(filePath, permissions);
      }
    }
  }

  /**
   * Check that system prerequisites are met.
   * Throws CurlNotFoundError if curl is not available.
   */
  checkSystemPrerequisites(): void {
    if (!findInPath(this.curlCommand)) {
      throw new CurlNotFoundError(this.curlCommand);
    }
  }
}

/**
 * Global configuration singleton, initialized from process.env at import time.
 */
export const CONFIG = new Config();
