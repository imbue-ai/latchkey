/**
 * Shared operation functions used by both the CLI and the HTTP endpoint.
 *
 * These functions contain the core business logic for most latchkey commands.
 * They accept explicit dependencies, return data, and throw dedicated errors
 * rather than writing to stdout or calling process.exit.
 */

import { ApiCredentialStatus } from './apiCredentials/base.js';
import { corruptEntryRemedy, type ApiCredentialStore } from './apiCredentials/store.js';
import { getCredentialStatus } from './apiCredentials/utils.js';
import type { Config } from './config.js';
import { loadBrowserConfig } from './configDataStore.js';
import type { EncryptedStorage } from './encryptedStorage.js';
import {
  BrowserDisabledError,
  BrowserFlowsNotSupportedError,
  GraphicalEnvironmentNotFoundError,
  hasGraphicalEnvironment,
} from './playwrightUtils.js';
import type { ServiceRegistry } from './serviceRegistry.js';
import { isBrowserClosedError, LoginCancelledError } from './services/core/base.js';
import { RegisteredService } from './services/core/registered.js';
import type { Service } from './services/index.js';

// Error classes

export class UnknownServiceError extends Error {
  constructor(serviceName: string) {
    super(
      `Unknown service: ${serviceName}. Use 'latchkey services list' to see available services.`
    );
    this.name = 'UnknownServiceError';
  }
}

export class BrowserNotConfiguredError extends Error {
  constructor() {
    super("No browser configured. Run 'latchkey ensure-browser' first.");
    this.name = 'BrowserNotConfiguredError';
  }
}

export class PreparationRequiredError extends Error {
  constructor(serviceName: string) {
    super(
      `Service ${serviceName} requires preparation first. ` +
        `Run 'latchkey auth browser-prepare ${serviceName}' before logging in.`
    );
    this.name = 'PreparationRequiredError';
  }
}

// Helpers

function lookupService(registry: ServiceRegistry, serviceName: string): Service {
  const service = registry.getByName(serviceName);
  if (service === null) {
    throw new UnknownServiceError(serviceName);
  }
  return service;
}

function getBrowserLaunchOptions(config: Config): {
  browserStatePath: string;
  executablePath: string;
} {
  if (config.browserDisabled) {
    throw new BrowserDisabledError();
  }
  if (!hasGraphicalEnvironment()) {
    throw new GraphicalEnvironmentNotFoundError();
  }
  const browserConfig = loadBrowserConfig(config.configPath);
  if (!browserConfig) {
    throw new BrowserNotConfiguredError();
  }
  return {
    browserStatePath: config.browserStatePath,
    executablePath: browserConfig.executablePath,
  };
}

// Operations

export function servicesList(
  registry: ServiceRegistry,
  apiCredentialStore: ApiCredentialStore,
  config: Config,
  options: { builtin?: boolean; viable?: boolean }
): readonly string[] {
  let services = [...registry.services];

  if (options.builtin === true) {
    services = services.filter((service) => !(service instanceof RegisteredService));
  }

  if (options.viable === true) {
    const allCredentials = apiCredentialStore.getAll().credentials;
    services = services.filter((service) => {
      if (allCredentials.has(service.name)) {
        return true;
      }
      const supportsBrowser =
        service.getSession !== undefined && !config.browserDisabled && hasGraphicalEnvironment();
      return supportsBrowser;
    });
  }

  return services.map((service) => service.name).sort();
}

export interface ServicesInfoResult {
  readonly type: 'built-in' | 'user-registered';
  readonly baseApiUrls: readonly (string | RegExp)[];
  readonly authOptions: readonly string[];
  readonly credentialStatus: ApiCredentialStatus;
  readonly setCredentialsExample: string;
  readonly developerNotes: string;
}

export async function servicesInfo(
  registry: ServiceRegistry,
  apiCredentialStore: ApiCredentialStore,
  config: Config,
  serviceName: string
): Promise<ServicesInfoResult> {
  const service = lookupService(registry, serviceName);

  const supportsBrowser = service.getSession !== undefined && !config.browserDisabled;
  const authOptions = supportsBrowser ? ['browser', 'set'] : ['set'];

  const apiCredentials = apiCredentialStore.get(serviceName);
  const credentialStatus = await getCredentialStatus(service, apiCredentials, apiCredentialStore);

  const serviceType = service instanceof RegisteredService ? 'user-registered' : 'built-in';

  return {
    type: serviceType,
    baseApiUrls: service.baseApiUrls,
    authOptions,
    credentialStatus,
    setCredentialsExample: service.setCredentialsExample(serviceName),
    developerNotes: service.info,
  };
}

export interface AuthListEntry {
  readonly credentialType: string;
  readonly credentialStatus: ApiCredentialStatus;
  /** Only present for corrupt entries: what is wrong and how to remove the entry. */
  readonly error?: string;
}

export async function authList(
  registry: ServiceRegistry,
  apiCredentialStore: ApiCredentialStore
): Promise<Record<string, AuthListEntry>> {
  const { credentials: allCredentials, brokenEntries } = apiCredentialStore.getAll();

  const statusChecks = Array.from(
    allCredentials,
    async ([serviceName, credentials]): Promise<readonly [string, AuthListEntry]> => {
      const service = registry.getByName(serviceName);
      const credentialStatus =
        service !== null
          ? await getCredentialStatus(service, credentials, apiCredentialStore)
          : ApiCredentialStatus.Valid;

      return [serviceName, { credentialType: credentials.objectType, credentialStatus }];
    }
  );

  const entries = new Map<string, AuthListEntry>(await Promise.all(statusChecks));
  for (const [serviceName, brokenEntry] of brokenEntries) {
    entries.set(serviceName, {
      credentialType: brokenEntry.objectType ?? 'unknown',
      credentialStatus: ApiCredentialStatus.Corrupt,
      error: `${brokenEntry.error}. ${corruptEntryRemedy(serviceName)}`,
    });
  }
  // Object.fromEntries creates own properties, so a service name like
  // '__proto__' still becomes a visible row.
  return Object.fromEntries(entries);
}

export async function authBrowser(
  registry: ServiceRegistry,
  apiCredentialStore: ApiCredentialStore,
  encryptedStorage: EncryptedStorage,
  config: Config,
  serviceName: string
): Promise<void> {
  const service = lookupService(registry, serviceName);

  const session = service.getSession?.(config.appNamePrefix);
  if (!session) {
    throw new BrowserFlowsNotSupportedError(serviceName);
  }

  const oldCredentials = apiCredentialStore.get(service.name);
  if (session.prepare && oldCredentials === null) {
    throw new PreparationRequiredError(serviceName);
  }

  const launchOptions = getBrowserLaunchOptions(config);

  const apiCredentials = await session.login(
    encryptedStorage,
    launchOptions,
    oldCredentials ?? undefined
  );
  apiCredentialStore.save(service.name, apiCredentials);
}

export interface AuthBrowserPrepareResult {
  readonly alreadyPrepared: boolean;
}

export async function authBrowserPrepare(
  registry: ServiceRegistry,
  apiCredentialStore: ApiCredentialStore,
  encryptedStorage: EncryptedStorage,
  config: Config,
  serviceName: string
): Promise<AuthBrowserPrepareResult> {
  const service = lookupService(registry, serviceName);

  const session = service.getSession?.(config.appNamePrefix);
  if (!session?.prepare) {
    return { alreadyPrepared: true };
  }

  const existingCredentials = apiCredentialStore.get(service.name);
  if (existingCredentials !== null) {
    return { alreadyPrepared: true };
  }

  const launchOptions = getBrowserLaunchOptions(config);

  let apiCredentials;
  try {
    apiCredentials = await session.prepare(encryptedStorage, launchOptions);
  } catch (error: unknown) {
    // Closing the browser window during preparation should be reported to
    // the user as a clean cancellation rather than a stack trace. Doing
    // this here means every service's prepare() gets the same treatment
    // without having to repeat the wrapping in each implementation.
    if (error instanceof Error && isBrowserClosedError(error)) {
      throw new LoginCancelledError();
    }
    throw error;
  }
  apiCredentialStore.save(service.name, apiCredentials);
  return { alreadyPrepared: false };
}
