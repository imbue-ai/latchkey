/**
 * A runtime: Latchkey's working state for one directory.
 *
 * The command line builds its state from the process's environment. A program
 * that embeds Latchkey builds a runtime from values it passes instead: the
 * directory, the encryption key and the settings it wants. Nothing here reads
 * the environment or the keychain.
 */

import { isAbsolute } from 'node:path';
import type { ApiCredentialsType } from './apiCredentials/base.js';
import { BUILTIN_API_CREDENTIALS_TYPES } from './apiCredentials/serialization.js';
import { ApiCredentialStore } from './apiCredentials/store.js';
import { Config } from './config.js';
import { loadSettings, type Settings } from './configDataStore.js';
import { getCurlCommand, runAsync as curlRunAsync, setCurlCommand } from './curl.js';
import type { PermissionCheckDependencies } from './curlInjection.js';
import { EncryptedStorage } from './encryptedStorage.js';
import { encrypt } from './encryption.js';
import { LATCHKEY_DIRECTORY_ENV_VAR } from './environment.js';
import { derivePermissionsOverrideSigningKey } from './gateway/permissionsOverride.js';
import { runMigrations } from './migrations.js';
import { checkPermission } from './permissions.js';
import {
  combineWithPluginApiCredentialsTypes,
  combineWithPluginServices,
  loadPlugins,
} from './plugins.js';
import { createLatchkeySdk } from './pluginSdk.js';
import { BUILTIN_SERVICES, createServiceRegistry, ServiceRegistry } from './serviceRegistry.js';
import type { Service } from './services/index.js';
import { VERSION } from './version.js';

export class InvalidRuntimeDirectoryError extends Error {
  constructor(directory: string) {
    super(`The Latchkey directory of a runtime must be an absolute path, got '${directory}'.`);
    this.name = 'InvalidRuntimeDirectoryError';
  }
}

export class CurlCommandConflictError extends Error {
  constructor(claimedCommand: string, requestedCommand: string) {
    super(
      `A runtime of this process already runs curl as '${claimedCommand}', so another cannot ` +
        `run it as '${requestedCommand}': the curl program is one value for the whole process.`
    );
    this.name = 'CurlCommandConflictError';
  }
}

export class UnknownRuntimeError extends Error {
  constructor() {
    super('This object is not a runtime that Latchkey created.');
    this.name = 'UnknownRuntimeError';
  }
}

/**
 * The settings a runtime can be given. Each one is a setting the command line
 * reads from an environment variable, and means what that variable means. A
 * setting left out takes the value of the `settings` section of the
 * directory's config.json, and the default when that names none.
 */
export interface LatchkeyRuntimeSettings {
  /** LATCHKEY_CURL. One value for the whole process. */
  readonly curlCommand?: string;
  /** LATCHKEY_PERMISSIONS_CONFIG. */
  readonly permissionsConfigPath?: string;
  /** LATCHKEY_PERMISSIONS_DO_NOT_USE_BUILTIN_SCHEMAS. */
  readonly permissionsDoNotUseBuiltinSchemas?: boolean;
  /** LATCHKEY_PASSTHROUGH_UNKNOWN. */
  readonly passthroughUnknown?: boolean;
  /** LATCHKEY_DIAGNOSTIC_HEADERS. */
  readonly diagnosticHeaders?: boolean;
  /** LATCHKEY_DISABLE_CREDENTIALS_REFRESH. */
  readonly credentialsRefreshDisabled?: boolean;
  /** LATCHKEY_HIDE_BUILTIN_SERVICES. */
  readonly hideBuiltinServices?: readonly string[];
  /** LATCHKEY_DISABLE_BROWSER. */
  readonly browserDisabled?: boolean;
  /** LATCHKEY_EPHEMERAL_BROWSER. */
  readonly browserEphemeral?: boolean;
  /** LATCHKEY_APP_NAME_PREFIX. */
  readonly appNamePrefix?: string;
}

export interface LatchkeyRuntimeOptions {
  /** Absolute path of the Latchkey directory. */
  readonly directory: string;
  /** The key the directory's store and browser state are encrypted with: 32 bytes, base64. */
  readonly encryptionKey: string;
  readonly settings?: LatchkeyRuntimeSettings;
  readonly log: (message: string) => void;
  readonly errorLog: (message: string) => void;
}

export interface LatchkeyRuntime {
  readonly config: Config;
  readonly encryptedStorage: EncryptedStorage;
  readonly apiCredentialStore: ApiCredentialStore;
  /** The services Latchkey ships with, followed by those of the directory's plugins. */
  readonly baseServices: readonly Service[];
  /** The credential types Latchkey ships with, followed by those of the directory's plugins. */
  readonly apiCredentialsTypes: readonly ApiCredentialsType[];
  /** A registry over `baseServices` and the services config.json registers as it reads now. */
  readonly createServiceRegistry: () => ServiceRegistry;
  readonly log: (message: string) => void;
  readonly errorLog: (message: string) => void;
  /** The version of the Latchkey package. */
  readonly version: string;
}

/**
 * What a runtime holds beyond its public fields. Kept off the object so that
 * the signing key is not something a caller can read, and so that the seams
 * the tests replace are not part of the public interface.
 */
export interface LatchkeyRuntimeInternals {
  readonly permissionsOverrideSigningKey: Buffer;
  readonly runCurlAsync: typeof curlRunAsync;
  readonly checkPermission: PermissionCheckDependencies['checkPermission'];
}

/**
 * Everything a runtime is assembled from. The command line assembles one from
 * its own dependencies, and so do tests that replace the curl runner or the
 * permission check.
 */
export interface LatchkeyRuntimeParts extends LatchkeyRuntimeInternals {
  readonly config: Config;
  readonly encryptedStorage: EncryptedStorage;
  readonly apiCredentialStore: ApiCredentialStore;
  readonly baseServices: readonly Service[];
  readonly apiCredentialsTypes: readonly ApiCredentialsType[];
  readonly log: (message: string) => void;
  readonly errorLog: (message: string) => void;
  readonly version: string;
}

const runtimeInternals = new WeakMap<LatchkeyRuntime, LatchkeyRuntimeInternals>();

export function assembleLatchkeyRuntime(parts: LatchkeyRuntimeParts): LatchkeyRuntime {
  const runtime: LatchkeyRuntime = Object.freeze({
    config: parts.config,
    encryptedStorage: parts.encryptedStorage,
    apiCredentialStore: parts.apiCredentialStore,
    baseServices: parts.baseServices,
    apiCredentialsTypes: parts.apiCredentialsTypes,
    createServiceRegistry: () =>
      createServiceRegistry(
        parts.baseServices,
        parts.config.configPath,
        parts.config.hideBuiltinServices
      ),
    log: parts.log,
    errorLog: parts.errorLog,
    version: parts.version,
  });
  runtimeInternals.set(runtime, {
    permissionsOverrideSigningKey: parts.permissionsOverrideSigningKey,
    runCurlAsync: parts.runCurlAsync,
    checkPermission: parts.checkPermission,
  });
  return runtime;
}

export function getLatchkeyRuntimeInternals(runtime: LatchkeyRuntime): LatchkeyRuntimeInternals {
  const internals = runtimeInternals.get(runtime);
  if (internals === undefined) {
    throw new UnknownRuntimeError();
  }
  return internals;
}

/**
 * The curl command the runtimes of this process agreed on, or null while no
 * runtime was created. See `setCurlCommand` in `curl.ts` for why it is a
 * value of the process.
 */
let claimedCurlCommand: string | null = null;

function claimCurlCommand(command: string): void {
  if (claimedCurlCommand !== null && claimedCurlCommand !== command) {
    throw new CurlCommandConflictError(claimedCurlCommand, command);
  }
  claimedCurlCommand = command;
  if (getCurlCommand() !== command) {
    setCurlCommand(command);
  }
}

/** Forget the curl command the runtimes of this process agreed on. For tests. */
export function resetClaimedCurlCommand(): void {
  claimedCurlCommand = null;
}

/**
 * The caller's settings in the shape of config.json's `settings` section,
 * holding only the ones the caller named: a key that is present overrides the
 * file's, so one the caller left out must be absent rather than undefined.
 */
function toFileSettings(settings: LatchkeyRuntimeSettings): Settings {
  const candidates: Readonly<Record<string, unknown>> = {
    curlCommand: settings.curlCommand,
    permissionsConfig: settings.permissionsConfigPath,
    permissionsDoNotUseBuiltinSchemas: settings.permissionsDoNotUseBuiltinSchemas,
    passthroughUnknown: settings.passthroughUnknown,
    diagnosticHeaders: settings.diagnosticHeaders,
    credentialsRefreshDisabled: settings.credentialsRefreshDisabled,
    hideBuiltinServices:
      settings.hideBuiltinServices === undefined ? undefined : [...settings.hideBuiltinServices],
    browserDisabled: settings.browserDisabled,
    browserEphemeral: settings.browserEphemeral,
    appNamePrefix: settings.appNamePrefix,
  };
  const named: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(candidates)) {
    if (value !== undefined) {
      named[key] = value;
    }
  }
  return named;
}

/**
 * Build the configuration of a runtime: the caller's settings over the
 * `settings` section of the directory's config.json over the defaults, with no
 * environment variable consulted.
 */
function buildRuntimeConfig(directory: string, settings: LatchkeyRuntimeSettings): Config {
  const callerSettings = toFileSettings(settings);
  return new Config(
    (name) => (name === LATCHKEY_DIRECTORY_ENV_VAR ? directory : undefined),
    (configPath) => {
      // `gateway` would make the configuration that of a client of another
      // gateway, and a runtime always works on its own directory.
      const { gateway: _gateway, ...fileSettings } = loadSettings(configPath);
      return { ...fileSettings, ...callerSettings };
    }
  );
}

/**
 * Create the runtime of a directory.
 *
 * In order, and throwing the named error at the first step that fails:
 *
 * 1. validates the encryption key (`EncryptionError`);
 * 2. builds the configuration from the directory and the settings;
 * 3. checks that curl can be found (`CurlNotFoundError`);
 * 4. checks that the credential store and the browser state, when they exist,
 *    are readable by their owner only (`InsecureFilePermissionsError`);
 * 5. loads the plugins of the directory (`PluginLoadError`);
 * 6. runs the data-format migrations of the directory (`MigrationError`).
 *
 * It does not open the credential store, so a key that cannot decrypt it is
 * found by the first operation that reads the store. It never consults the
 * keychain, never sends the usage ping and loads no browser.
 */
export async function createLatchkeyRuntime(
  options: LatchkeyRuntimeOptions
): Promise<LatchkeyRuntime> {
  if (!isAbsolute(options.directory)) {
    throw new InvalidRuntimeDirectoryError(options.directory);
  }
  // Validate the key with the encryption routine itself, rather than
  // duplicating its key-format checks.
  encrypt('', options.encryptionKey);

  const config = buildRuntimeConfig(options.directory, options.settings ?? {});
  config.checkSystemPrerequisites();
  config.checkSensitiveFilePermissions();
  claimCurlCommand(config.curlCommand);

  const plugins = await loadPlugins(config.pluginsDirectoryPath, createLatchkeySdk(VERSION));
  const baseServices = combineWithPluginServices(BUILTIN_SERVICES, plugins);
  const apiCredentialsTypes = combineWithPluginApiCredentialsTypes(
    BUILTIN_API_CREDENTIALS_TYPES,
    plugins
  );

  const encryptedStorage = new EncryptedStorage(options.encryptionKey);
  await runMigrations(config, encryptedStorage);

  return assembleLatchkeyRuntime({
    config,
    encryptedStorage,
    apiCredentialStore: new ApiCredentialStore(
      config.credentialStorePath,
      encryptedStorage,
      apiCredentialsTypes
    ),
    baseServices,
    apiCredentialsTypes,
    permissionsOverrideSigningKey: derivePermissionsOverrideSigningKey(options.encryptionKey),
    runCurlAsync: curlRunAsync,
    checkPermission,
    log: options.log,
    errorLog: options.errorLog,
    version: VERSION,
  });
}
