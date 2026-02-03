/**
 * Configuration management for Latchkey.
 */

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { getDefaultConfigPath } from './browserConfig.js';
import { isKeychainAvailable } from './keychain.js';

export class InsecureFilePermissionsError extends Error {
  constructor(filePath: string, permissions: number) {
    const permissionsOctal = permissions.toString(8).padStart(3, '0');
    super(
      `File ${filePath} has insecure permissions (${permissionsOctal}). Run: chmod 600 ${filePath}`
    );
    this.name = 'InsecureFilePermissionsError';
  }
}

const LATCHKEY_STORE_ENV_VAR = 'LATCHKEY_STORE';
const LATCHKEY_BROWSER_STATE_ENV_VAR = 'LATCHKEY_BROWSER_STATE';
const LATCHKEY_CONFIG_ENV_VAR = 'LATCHKEY_CONFIG';
const LATCHKEY_CURL_PATH_ENV_VAR = 'LATCHKEY_CURL_PATH';
const LATCHKEY_ENCRYPTION_KEY_ENV_VAR = 'LATCHKEY_ENCRYPTION_KEY';
const LATCHKEY_KEYRING_SERVICE_NAME_ENV_VAR = 'LATCHKEY_KEYRING_SERVICE_NAME';
const LATCHKEY_KEYRING_ACCOUNT_NAME_ENV_VAR = 'LATCHKEY_KEYRING_ACCOUNT_NAME';

export const DEFAULT_KEYRING_SERVICE_NAME = 'latchkey';
export const DEFAULT_KEYRING_ACCOUNT_NAME = 'encryption-key';

function getDefaultCredentialStorePath(encryptionEnabled: boolean): string {
  const filename = encryptionEnabled ? 'credentials.json.enc' : 'credentials.json';
  return join(homedir(), '.latchkey', filename);
}

function getDefaultBrowserStatePath(encryptionEnabled: boolean): string {
  const filename = encryptionEnabled ? 'browser_state.json.enc' : 'browser_state.json';
  return join(homedir(), '.latchkey', filename);
}

function resolvePathWithTildeExpansion(path: string): string {
  if (path.startsWith('~')) {
    return resolve(homedir(), path.slice(2));
  }
  return resolve(path);
}

/**
 * Configuration for Latchkey, sourced from environment variables with sensible defaults.
 */
export class Config {
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

  constructor(getEnv: (name: string) => string | undefined = (name) => process.env[name]) {
    this.curlCommand = getEnv(LATCHKEY_CURL_PATH_ENV_VAR) ?? 'curl';
    this.encryptionKeyOverride = getEnv(LATCHKEY_ENCRYPTION_KEY_ENV_VAR) ?? null;
    this.serviceName =
      getEnv(LATCHKEY_KEYRING_SERVICE_NAME_ENV_VAR) ?? DEFAULT_KEYRING_SERVICE_NAME;
    this.accountName =
      getEnv(LATCHKEY_KEYRING_ACCOUNT_NAME_ENV_VAR) ?? DEFAULT_KEYRING_ACCOUNT_NAME;

    // Determine if encryption will be enabled (either via key override or keychain)
    const encryptionEnabled =
      this.encryptionKeyOverride !== null ||
      isKeychainAvailable(this.serviceName, this.accountName);

    const credentialStoreEnv = getEnv(LATCHKEY_STORE_ENV_VAR);
    this.credentialStorePath = credentialStoreEnv
      ? resolvePathWithTildeExpansion(credentialStoreEnv)
      : getDefaultCredentialStorePath(encryptionEnabled);

    const browserStateEnv = getEnv(LATCHKEY_BROWSER_STATE_ENV_VAR);
    this.browserStatePath = browserStateEnv
      ? resolvePathWithTildeExpansion(browserStateEnv)
      : getDefaultBrowserStatePath(encryptionEnabled);

    const configEnv = getEnv(LATCHKEY_CONFIG_ENV_VAR);
    this.configPath = configEnv
      ? resolvePathWithTildeExpansion(configEnv)
      : getDefaultConfigPath();
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
}

/**
 * Global configuration singleton, initialized from process.env at import time.
 */
export const CONFIG = new Config();
