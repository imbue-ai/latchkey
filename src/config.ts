/**
 * Configuration management for Latchkey.
 */

import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { loadSettings, type Settings } from './configDataStore.js';

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
const LATCHKEY_DISABLE_COUNTING_ENV_VAR = 'LATCHKEY_DISABLE_COUNTING';
const LATCHKEY_PERMISSIONS_CONFIG_ENV_VAR = 'LATCHKEY_PERMISSIONS_CONFIG';
const LATCHKEY_PERMISSIONS_DO_NOT_USE_BUILTIN_SCHEMAS_ENV_VAR =
  'LATCHKEY_PERMISSIONS_DO_NOT_USE_BUILTIN_SCHEMAS';
const LATCHKEY_PASSTHROUGH_UNKNOWN_ENV_VAR = 'LATCHKEY_PASSTHROUGH_UNKNOWN';
const LATCHKEY_GATEWAY_ENV_VAR = 'LATCHKEY_GATEWAY';

export const DEFAULT_KEYRING_SERVICE_NAME = 'latchkey';
export const DEFAULT_KEYRING_ACCOUNT_NAME = 'encryption-key';

const DEFAULT_DIRECTORY = join(homedir(), '.latchkey');

const CREDENTIAL_STORE_FILENAME = 'credentials.json.enc';
const BROWSER_STATE_FILENAME = 'browser_state.json.enc';
const CONFIG_FILENAME = 'config.json';
const PERMISSIONS_CONFIG_FILENAME = 'permissions.json';

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
 * Resolve a string-valued setting with precedence: env var > config file > default.
 * Environment variables override even when set to an empty string.
 */
function resolveString(
  envValue: string | undefined,
  fileValue: string | undefined,
  defaultValue: string
): string {
  if (envValue !== undefined) return envValue;
  if (fileValue !== undefined) return fileValue;
  return defaultValue;
}

/**
 * Resolve an optional path/url-like setting with precedence: env var > config file > null.
 * Empty strings are treated as unset so that `FOO=` in the environment doesn't mask
 * a config file value.
 */
function resolveOptionalString(
  envValue: string | undefined,
  fileValue: string | undefined
): string | null {
  if (envValue !== undefined && envValue !== '') return envValue;
  if (fileValue !== undefined && fileValue !== '') return fileValue;
  return null;
}

/**
 * Resolve a boolean flag with precedence: env var > config file > false.
 * A non-empty env var means true. An unset or empty env var falls through
 * (consistent with how the README describes LATCHKEY_DISABLE_*).
 */
function resolveBoolean(envValue: string | undefined, fileValue: boolean | undefined): boolean {
  if (envValue !== undefined && envValue !== '') return true;
  if (fileValue !== undefined) return fileValue;
  return false;
}

/**
 * Configuration for Latchkey, sourced from environment variables and config.json with sensible defaults.
 * Precedence for each setting: environment variable > config.json > default.
 * LATCHKEY_DIRECTORY and LATCHKEY_ENCRYPTION_KEY are env-only.
 */
export class Config {
  readonly directory: string;
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
  /**
   * When true, daily counting is disabled.
   */
  readonly countingDisabled: boolean;
  /**
   * Override for the permissions config file path.
   * When set, this path is used instead of the default LATCHKEY_DIRECTORY/permissions.json.
   */
  readonly permissionsConfigOverride: string | null;
  /**
   * When true, detent's built-in schemas are not used during permission checks.
   */
  readonly permissionsDoNotUseBuiltinSchemas: boolean;
  /**
   * When true, requests to unrecognized services or services without credentials
   * are passed through as-is instead of being rejected.
   */
  readonly passthroughUnknown: boolean;
  /**
   * When set, the CLI delegates commands to a remote latchkey gateway instead
   * of running them locally. `latchkey curl` is proxied through the gateway's
   * `/gateway/` endpoint; most other commands are forwarded to `/latchkey/`.
   */
  readonly gatewayUrl: string | null;

  constructor(
    getEnv: (name: string) => string | undefined = (name) => process.env[name],
    loadSettingsFromFile: (configPath: string) => Settings = loadSettings
  ) {
    // The directory and encryption key are configured exclusively via environment variables;
    // they cannot be set from config.json (the directory determines where config.json lives).
    const directoryEnv = getEnv(LATCHKEY_DIRECTORY_ENV_VAR);
    this.directory = directoryEnv ? resolvePathWithTildeExpansion(directoryEnv) : DEFAULT_DIRECTORY;
    this.encryptionKeyOverride = getEnv(LATCHKEY_ENCRYPTION_KEY_ENV_VAR) ?? null;

    const settings = loadSettingsFromFile(join(this.directory, CONFIG_FILENAME));

    this.curlCommand = resolveString(getEnv(LATCHKEY_CURL_ENV_VAR), settings.curlCommand, 'curl');
    this.serviceName = resolveString(
      getEnv(LATCHKEY_KEYRING_SERVICE_NAME_ENV_VAR),
      settings.keyringServiceName,
      DEFAULT_KEYRING_SERVICE_NAME
    );
    this.accountName = resolveString(
      getEnv(LATCHKEY_KEYRING_ACCOUNT_NAME_ENV_VAR),
      settings.keyringAccountName,
      DEFAULT_KEYRING_ACCOUNT_NAME
    );

    this.browserDisabled = resolveBoolean(
      getEnv(LATCHKEY_DISABLE_BROWSER_ENV_VAR),
      settings.browserDisabled
    );
    this.countingDisabled = resolveBoolean(
      getEnv(LATCHKEY_DISABLE_COUNTING_ENV_VAR),
      settings.countingDisabled
    );
    this.permissionsDoNotUseBuiltinSchemas = resolveBoolean(
      getEnv(LATCHKEY_PERMISSIONS_DO_NOT_USE_BUILTIN_SCHEMAS_ENV_VAR),
      settings.permissionsDoNotUseBuiltinSchemas
    );
    this.passthroughUnknown = resolveBoolean(
      getEnv(LATCHKEY_PASSTHROUGH_UNKNOWN_ENV_VAR),
      settings.passthroughUnknown
    );

    const permissionsConfig = resolveOptionalString(
      getEnv(LATCHKEY_PERMISSIONS_CONFIG_ENV_VAR),
      settings.permissionsConfig
    );
    this.permissionsConfigOverride = permissionsConfig;

    const gatewayUrl = resolveOptionalString(getEnv(LATCHKEY_GATEWAY_ENV_VAR), settings.gateway);
    this.gatewayUrl = gatewayUrl ? gatewayUrl.replace(/\/+$/, '') : null;
  }

  get credentialStorePath(): string {
    return join(this.directory, CREDENTIAL_STORE_FILENAME);
  }

  get browserStatePath(): string {
    return join(this.directory, BROWSER_STATE_FILENAME);
  }

  get configPath(): string {
    return join(this.directory, CONFIG_FILENAME);
  }

  get permissionsConfigPath(): string {
    return this.permissionsConfigOverride ?? join(this.directory, PERMISSIONS_CONFIG_FILENAME);
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
