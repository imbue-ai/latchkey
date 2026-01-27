/**
 * Configuration management for Latchkey.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const LATCHKEY_STORE_ENV_VAR = 'LATCHKEY_STORE';
const LATCHKEY_BROWSER_STATE_ENV_VAR = 'LATCHKEY_BROWSER_STATE';
const LATCHKEY_CURL_PATH_ENV_VAR = 'LATCHKEY_CURL_PATH';

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
  }
}

/**
 * Global configuration singleton, initialized from process.env at import time.
 */
export const CONFIG = new Config();
