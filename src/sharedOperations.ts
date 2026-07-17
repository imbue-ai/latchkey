/**
 * Shared operation functions used by both the CLI and the HTTP endpoint.
 *
 * These functions contain the core business logic for most latchkey commands.
 * They accept explicit dependencies, return data, and throw dedicated errors
 * rather than writing to stdout or calling process.exit.
 */

import { DEFAULT_ACCOUNT } from './apiCredentials/account.js';
import {
  ApiCredentialStatus,
  OAuthCredentials,
  type ApiCredentials,
} from './apiCredentials/base.js';
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
  config: Config
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
        false
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
  serviceName: string
): Promise<AuthBrowserResult> {
  const service = lookupService(registry, serviceName);

  const session = service.getSession?.(config.appNamePrefix);
  if (!session) {
    throw new BrowserFlowsNotSupportedError(serviceName);
  }

  // Login reuses stored credentials only for service-level artifacts (e.g.
  // the OAuth client created by browser-prepare), which all of a service's
  // accounts share — so logging in to an additional account can borrow any
  // stored account's credentials. Prefer the default account, where
  // browser-prepare places the client before the first login.
  const storedAccounts = apiCredentialStore.listAccounts(service.name);
  const reusableAccount = storedAccounts.includes(DEFAULT_ACCOUNT)
    ? DEFAULT_ACCOUNT
    : storedAccounts[0];
  const oldCredentials =
    reusableAccount === undefined ? null : apiCredentialStore.get(service.name, reusableAccount);
  if (session.prepare && oldCredentials === null) {
    throw new PreparationRequiredError(serviceName);
  }

  const launchOptions = getBrowserLaunchOptions(config);

  // The browser flow reports which account the user logged in as, so the
  // credentials are stored under that account.
  const { credentials, account } = await session.login(
    encryptedStorage,
    launchOptions,
    oldCredentials ?? undefined
  );
  apiCredentialStore.save(service.name, credentials, account);
  removeObsoletePreparedCredentials(apiCredentialStore, service.name, account);
  return { account };
}

/**
 * After a login stores credentials under a real account, drop a leftover
 * token-less entry under the default account — the placeholder created by
 * `auth browser-prepare`. Its purpose (carrying the OAuth client to the first
 * login) is served, and the client lives on inside every logged-in account's
 * credentials; keeping the placeholder would only make account resolution
 * ambiguous. Complete credentials under the default account are left alone.
 */
function removeObsoletePreparedCredentials(
  apiCredentialStore: ApiCredentialStore,
  serviceName: string,
  savedAccount: string
): void {
  if (savedAccount === DEFAULT_ACCOUNT) {
    return;
  }
  const defaultAccountCredentials = apiCredentialStore.get(serviceName, DEFAULT_ACCOUNT);
  if (
    defaultAccountCredentials instanceof OAuthCredentials &&
    defaultAccountCredentials.accessToken === undefined
  ) {
    apiCredentialStore.delete(serviceName, DEFAULT_ACCOUNT);
  }
}

export interface AuthBrowserPrepareResult {
  readonly alreadyPrepared: boolean;
  readonly account?: string;
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

  let credentials;
  let account: string;
  try {
    ({ credentials, account } = await session.prepare(encryptedStorage, launchOptions));
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
  apiCredentialStore.save(service.name, credentials, account);
  return { alreadyPrepared: false, account };
}

export interface PrepareServiceResult {
  readonly serviceName: string;
  readonly credentialType: string;
}

/**
 * Store credentials for a service from a validated JSON payload
 * (`latchkey auth prepare <service> <json>`). The whole operation is rejected — and
 * nothing is stored — if the JSON is malformed, fails the service's schema, or
 * the service does not support prepare.
 */
export function prepareService(
  registry: ServiceRegistry,
  apiCredentialStore: ApiCredentialStore,
  serviceName: string,
  json: string,
  account?: string
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
  apiCredentialStore.save(service.name, credentials, account);
  return { serviceName: service.name, credentialType: credentials.objectType };
}
