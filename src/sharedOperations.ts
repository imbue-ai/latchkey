/**
 * Shared operation functions used by both the CLI and the HTTP endpoint.
 *
 * These functions contain the core business logic for most latchkey commands.
 * They accept explicit dependencies, return data, and throw dedicated errors
 * rather than writing to stdout or calling process.exit.
 */

import { ApiCredentialStatus, type ApiCredentials } from './apiCredentials/base.js';
import type { ApiCredentialStore } from './apiCredentials/store.js';
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
import {
  isBrowserClosedError,
  LoginCancelledError,
  PrepareInputInvalidError,
  PrepareNotSupportedError,
} from './services/core/base.js';
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
        `Run 'latchkey auth browser-prepare ${serviceName}' before logging in, ` +
        `or pass --account to reuse the client stored with an existing account's credentials.`
    );
    this.name = 'PreparationRequiredError';
  }
}

/**
 * Thrown when an explicitly named account has no stored credentials.
 */
export class AccountNotFoundError extends Error {
  constructor(serviceName: string, account: string) {
    super(`No credentials stored for account '${account}' of service '${serviceName}'.`);
    this.name = 'AccountNotFoundError';
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
  browserStatePath?: string;
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
  // In ephemeral mode we omit the state path entirely, so browser flows neither
  // load previously stored state nor persist their state anywhere.
  return {
    browserStatePath: config.browserEphemeral ? undefined : config.browserStatePath,
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
    const allCredentials = apiCredentialStore.getAll();
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

/**
 * Status of a single stored credential, keyed by account in the various
 * listings. Shared between `auth list` and `services info`.
 */
export interface CredentialStatusEntry {
  readonly credentialType: string;
  readonly credentialStatus: ApiCredentialStatus;
}

/**
 * A service's stored credentials keyed by account. The default account is
 * keyed by the empty string.
 */
export type AccountCredentialStatuses = Record<string, CredentialStatusEntry>;

async function computeAccountStatuses(
  registry: ServiceRegistry,
  apiCredentialStore: ApiCredentialStore,
  config: Config,
  serviceName: string,
  accountMap: ReadonlyMap<string, ApiCredentials> | undefined,
  offline: boolean
): Promise<AccountCredentialStatuses> {
  const service = registry.getByName(serviceName);
  const entries = await Promise.all(
    Array.from(accountMap ?? [], async ([account, credentials]) => {
      const credentialStatus =
        service !== null
          ? await getCredentialStatus(
              service,
              credentials,
              apiCredentialStore,
              config.credentialsRefreshDisabled,
              offline,
              account
            )
          : ApiCredentialStatus.Valid;
      return [account, { credentialType: credentials.objectType, credentialStatus }] as const;
    })
  );
  return Object.fromEntries(entries);
}

export interface ServicesInfoResult {
  readonly type: 'built-in' | 'user-registered';
  readonly baseApiUrls: readonly (string | RegExp)[];
  readonly authOptions: readonly string[];
  readonly credentials: AccountCredentialStatuses;
  readonly setCredentialsExample: string;
  readonly developerNotes: string;
}

export async function servicesInfo(
  registry: ServiceRegistry,
  apiCredentialStore: ApiCredentialStore,
  config: Config,
  serviceName: string,
  offline = false
): Promise<ServicesInfoResult> {
  const service = lookupService(registry, serviceName);

  const supportsBrowser = service.getSession !== undefined && !config.browserDisabled;
  const authOptions = supportsBrowser ? ['browser', 'set'] : ['set'];

  const accountMap = apiCredentialStore.getAll().get(serviceName);
  const credentials = await computeAccountStatuses(
    registry,
    apiCredentialStore,
    config,
    serviceName,
    accountMap,
    offline
  );

  const serviceType = service instanceof RegisteredService ? 'user-registered' : 'built-in';

  return {
    type: serviceType,
    baseApiUrls: service.baseApiUrls,
    authOptions,
    credentials,
    setCredentialsExample: service.setCredentialsExample(serviceName),
    developerNotes: service.info,
  };
}

export async function authList(
  registry: ServiceRegistry,
  apiCredentialStore: ApiCredentialStore,
  config: Config,
  offline = false
): Promise<Record<string, AccountCredentialStatuses>> {
  const allCredentials = apiCredentialStore.getAll();

  const entries = await Promise.all(
    Array.from(allCredentials, async ([serviceName, accountMap]) => {
      const statuses = await computeAccountStatuses(
        registry,
        apiCredentialStore,
        config,
        serviceName,
        accountMap,
        offline
      );
      return [serviceName, statuses] as const;
    })
  );

  return Object.fromEntries(entries);
}

export interface AuthBrowserResult {
  readonly account: string;
}

export async function authBrowser(
  registry: ServiceRegistry,
  apiCredentialStore: ApiCredentialStore,
  encryptedStorage: EncryptedStorage,
  config: Config,
  serviceName: string,
  account?: string
): Promise<AuthBrowserResult> {
  const service = lookupService(registry, serviceName);

  const session = service.getSession?.(config.appNamePrefix);
  if (!session) {
    throw new BrowserFlowsNotSupportedError(serviceName);
  }

  // Login reuses previously stored credentials only for service-level
  // artifacts (e.g. an OAuth client), which all of a service's accounts can
  // share. By default the service's preparation (created by `auth prepare` or
  // `auth browser-prepare`) is used; with an explicit account, that account's
  // stored credentials carry the client instead. Either way the login may
  // still end up stored under a different account — whichever the user logs
  // in as.
  let oldCredentials: ApiCredentials | null;
  if (account !== undefined) {
    oldCredentials = apiCredentialStore.get(service.name, account);
    if (oldCredentials === null) {
      throw new AccountNotFoundError(serviceName, account);
    }
  } else {
    oldCredentials = apiCredentialStore.getPreparation(service.name);
  }
  if (session.prepare && oldCredentials === null) {
    throw new PreparationRequiredError(serviceName);
  }

  const launchOptions = getBrowserLaunchOptions(config);

  // The browser flow reports which account the user logged in as, so the
  // credentials are stored under that account.
  const { credentials, account: loggedInAccount } = await session.login(
    encryptedStorage,
    launchOptions,
    oldCredentials ?? undefined
  );
  apiCredentialStore.save(service.name, credentials, loggedInAccount);
  return { account: loggedInAccount };
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

  // A preparation may already exist, but we still run the flow again: the
  // multi-account flow relies on people being able to prepare repeatedly to
  // create different OAuth clients. The new preparation overwrites the old one.
  const launchOptions = getBrowserLaunchOptions(config);

  let credentials: ApiCredentials;
  try {
    credentials = await session.prepare(encryptedStorage, launchOptions);
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
  apiCredentialStore.savePreparation(service.name, credentials);
  return { alreadyPrepared: false };
}

export interface PrepareServiceResult {
  readonly serviceName: string;
  readonly credentialType: string;
}

/**
 * Store a service's preparation from a validated JSON payload
 * (`latchkey auth prepare <service> <json>`), overwriting any previous
 * preparation. The whole operation is rejected — and nothing is stored — if
 * the JSON is malformed, fails the service's schema, or the service does not
 * support prepare.
 */
export function prepareService(
  registry: ServiceRegistry,
  apiCredentialStore: ApiCredentialStore,
  serviceName: string,
  json: string
): PrepareServiceResult {
  const service = lookupService(registry, serviceName);

  // Services opt in to prepare by implementing prepareFromJson; absence is the
  // default "not supported" state.
  if (service.prepareFromJson === undefined) {
    throw new PrepareNotSupportedError(serviceName);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(json);
  } catch (error: unknown) {
    throw new PrepareInputInvalidError(
      serviceName,
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // prepareFromJson validates against the service's schema and throws
  // PrepareInputInvalidError on any mismatch, so a store only happens once the
  // input is fully valid.
  const credentials = service.prepareFromJson(parsedJson);
  apiCredentialStore.savePreparation(service.name, credentials);
  return { serviceName: service.name, credentialType: credentials.objectType };
}
