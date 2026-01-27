/**
 * Configuration management for Latchkey.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const LATCHKEY_STORE_ENV_VAR = 'LATCHKEY_STORE';
const LATCHKEY_BROWSER_STATE_ENV_VAR = 'LATCHKEY_BROWSER_STATE';
const LATCHKEY_CURL_PATH_ENV_VAR = 'LATCHKEY_CURL_PATH';
const LATCHKEY_ENCRYPTION_KEY_ENV_VAR = 'LATCHKEY_ENCRYPTION_KEY';
const LATCHKEY_KEYRING_SERVICE_NAME_ENV_VAR = 'LATCHKEY_KEYRING_SERVICE_NAME';
const LATCHKEY_KEYRING_ACCOUNT_NAME_ENV_VAR = 'LATCHKEY_KEYRING_ACCOUNT_NAME';

export const DEFAULT_KEYRING_SERVICE_NAME = 'latchkey';
export const DEFAULT_KEYRING_ACCOUNT_NAME = 'encryption-key';

function getDefaultCredentialStorePath(): string {
  return join(homedir(), '.latchkey', 'credentials.json');
}

function getDefaultBrowserStatePath(): string {
  return join(homedir(), '.latchkey', 'browser_state.json');
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
    const credentialStoreEnv = getEnv(LATCHKEY_STORE_ENV_VAR);
    this.credentialStorePath = credentialStoreEnv
      ? resolvePathWithTildeExpansion(credentialStoreEnv)
      : getDefaultCredentialStorePath();

    const browserStateEnv = getEnv(LATCHKEY_BROWSER_STATE_ENV_VAR);
    this.browserStatePath = browserStateEnv
      ? resolvePathWithTildeExpansion(browserStateEnv)
      : getDefaultBrowserStatePath();

    this.curlCommand = getEnv(LATCHKEY_CURL_PATH_ENV_VAR) ?? 'curl';

    this.encryptionKeyOverride = getEnv(LATCHKEY_ENCRYPTION_KEY_ENV_VAR) ?? null;

    this.serviceName =
      getEnv(LATCHKEY_KEYRING_SERVICE_NAME_ENV_VAR) ?? DEFAULT_KEYRING_SERVICE_NAME;
    this.accountName =
      getEnv(LATCHKEY_KEYRING_ACCOUNT_NAME_ENV_VAR) ?? DEFAULT_KEYRING_ACCOUNT_NAME;
  }
}

/**
 * Global configuration singleton, initialized from process.env at import time.
 */
export const CONFIG = new Config();
