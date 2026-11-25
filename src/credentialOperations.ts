/**
 * Operations on stored credentials that both the command line and a program
 * that embeds Latchkey run: clearing an account, and re-encrypting credentials
 * from one directory into another.
 *
 * Neither prints, prompts, reads standard input or exits. A failure is a
 * typed error, which the command line turns into its message and exit code.
 */

import { existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ApiCredentials, ApiCredentialsType } from './apiCredentials/base.js';
import { ApiCredentialStore, ApiCredentialStoreError } from './apiCredentials/store.js';
import { Config } from './config.js';
import { EncryptedStorage, EncryptedStorageError } from './encryptedStorage.js';
import { encrypt, EncryptionError } from './encryption.js';
import { LATCHKEY_DIRECTORY_ENV_VAR } from './environment.js';
import {
  LATEST_VERSION,
  MigrationError,
  readDataFormatVersionOfDirectory,
  runMigrations,
  writeDataFormatVersionOfDirectory,
} from './migrations.js';
import type { LatchkeyRuntime } from './runtime.js';
import type { ServiceRegistry } from './serviceRegistry.js';
import { UnknownServiceError } from './sharedOperations.js';

/**
 * Which of a service's credentials an operation is about: those of one account
 * (the service's only account when none is named), or those of every account.
 */
export type CredentialsSelection =
  | { readonly kind: 'account'; readonly account?: string }
  | { readonly kind: 'allAccounts' };

/**
 * Clear stored credentials of a service. With an account selection, the
 * credentials of that account; with `allAccounts`, those of every account
 * together with the service's preparation. Returns whether anything was
 * deleted.
 *
 * Throws `UnknownServiceError` for a service the registry does not know, and
 * `AmbiguousAccountError` when no account is named and the service has several.
 */
export function clearServiceCredentials(
  registry: ServiceRegistry,
  apiCredentialStore: ApiCredentialStore,
  serviceName: string,
  selection: CredentialsSelection
): boolean {
  if (registry.getByName(serviceName) === null) {
    throw new UnknownServiceError(serviceName);
  }
  return selection.kind === 'allAccounts'
    ? apiCredentialStore.deleteAll(serviceName)
    : apiCredentialStore.delete(serviceName, selection.account);
}

/**
 * Clear stored credentials of a service in a runtime's directory: what
 * `latchkey auth clear <service>` does. See `clearServiceCredentials`.
 */
export function clearCredentials(
  runtime: LatchkeyRuntime,
  serviceName: string,
  selection: CredentialsSelection
): boolean {
  return clearServiceCredentials(
    runtime.createServiceRegistry(),
    runtime.apiCredentialStore,
    serviceName,
    selection
  );
}

/**
 * A condition that keeps credentials from being re-encrypted. `hint` is a
 * second line of advice that goes with the message, when there is one.
 */
export class ReencryptCredentialsError extends Error {
  readonly hint: string | null;

  constructor(message: string, hint: string | null = null) {
    super(message);
    this.name = 'ReencryptCredentialsError';
    this.hint = hint;
  }
}

export class DestinationNotADirectoryError extends ReencryptCredentialsError {
  constructor(destinationDirectory: string) {
    super(`Destination is not a directory: ${destinationDirectory}`);
    this.name = 'DestinationNotADirectoryError';
  }
}

export class InvalidDestinationKeyError extends ReencryptCredentialsError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDestinationKeyError';
  }
}

export class SourceCredentialsUnreadableError extends ReencryptCredentialsError {
  constructor(message: string) {
    super(message);
    this.name = 'SourceCredentialsUnreadableError';
  }
}

export class BrowserStateNotFoundError extends ReencryptCredentialsError {
  constructor(browserStatePath: string) {
    super(`No browser state found at ${browserStatePath}.`);
    this.name = 'BrowserStateNotFoundError';
  }
}

export class ServicesNotStoredError extends ReencryptCredentialsError {
  readonly serviceNames: readonly string[];

  constructor(serviceNames: readonly string[]) {
    super(`No stored credentials or preparation for: ${serviceNames.join(', ')}`);
    this.name = 'ServicesNotStoredError';
    this.serviceNames = serviceNames;
  }
}

export class AccountNotStoredError extends ReencryptCredentialsError {
  constructor(account: string) {
    super(`No stored credentials for account: ${account}`);
    this.name = 'AccountNotStoredError';
  }
}

export class NothingToReencryptError extends ReencryptCredentialsError {
  constructor() {
    super('No stored credentials found to re-encrypt.');
    this.name = 'NothingToReencryptError';
  }
}

export class DestinationDataFormatError extends ReencryptCredentialsError {
  constructor(message: string, hint: string | null = null) {
    super(message, hint);
    this.name = 'DestinationDataFormatError';
  }
}

export class DestinationCredentialsUnreadableError extends ReencryptCredentialsError {
  constructor(destinationStorePath: string, detail: string) {
    super(
      `Cannot read the existing credential store at ${destinationStorePath}: ${detail}`,
      'It must be readable with the new key to be added to.'
    );
    this.name = 'DestinationCredentialsUnreadableError';
  }
}

export interface ReencryptCredentialFilesOptions {
  readonly source: {
    readonly credentialStorePath: string;
    readonly browserStatePath: string;
    readonly encryptionKey: string;
  };
  readonly destination: {
    readonly directory: string;
    readonly encryptionKey: string;
  };
  /** Every credential type either store can hold. */
  readonly apiCredentialsTypes: readonly ApiCredentialsType[];
  /** Only these services; every stored service when left out. */
  readonly services?: readonly string[];
  /** Only this account's credentials of each selected service. */
  readonly account?: string;
  readonly isBrowserStateIncluded?: boolean;
}

export interface ReencryptCredentialsResult {
  /** The services whose credentials or preparation were written. */
  readonly services: readonly string[];
  /** The credential store the services were written into. */
  readonly credentialStorePath: string;
  /** The browser state that was written, or null when none was asked for. */
  readonly browserStatePath: string | null;
}

/**
 * Re-encrypt credentials from a store into a destination directory, under the
 * destination's key, using the file names the source uses.
 *
 * An existing store in the destination is kept and the selected services are
 * added to it. Without `account`, a selected service replaces the destination's
 * service of the same name; with it, only that account's credentials are
 * written, and the destination's other accounts of the service stay. A selected
 * service's preparation is carried over either way, since a preparation belongs
 * to no account.
 *
 * The source is read as it is: it must be in the newest data format.
 * `reencryptCredentials` is the form that migrates the source first.
 */
export function reencryptCredentialFiles(
  options: ReencryptCredentialFilesOptions
): ReencryptCredentialsResult {
  const destinationDirectory = options.destination.directory;
  if (existsSync(destinationDirectory) && !statSync(destinationDirectory).isDirectory()) {
    throw new DestinationNotADirectoryError(destinationDirectory);
  }

  const destinationStorePath = join(
    destinationDirectory,
    basename(options.source.credentialStorePath)
  );

  // Validate the key up front using the encryption routine itself, rather
  // than duplicating its key-format checks.
  try {
    encrypt('', options.destination.encryptionKey);
  } catch (error) {
    if (error instanceof EncryptionError) {
      throw new InvalidDestinationKeyError(error.message);
    }
    throw error;
  }

  const sourceStorage = new EncryptedStorage(options.source.encryptionKey);
  const sourceStore = new ApiCredentialStore(
    options.source.credentialStorePath,
    sourceStorage,
    options.apiCredentialsTypes
  );

  let allCredentials: ReadonlyMap<string, ReadonlyMap<string, ApiCredentials>>;
  let preparedServiceNames: readonly string[];
  try {
    allCredentials = sourceStore.getAll();
    preparedServiceNames = sourceStore.listPreparedServiceNames();
  } catch (error) {
    if (error instanceof ApiCredentialStoreError || error instanceof EncryptedStorageError) {
      throw new SourceCredentialsUnreadableError(error.message);
    }
    throw error;
  }

  let browserState: string | null = null;
  if (options.isBrowserStateIncluded === true) {
    try {
      browserState = sourceStorage.readFile(options.source.browserStatePath);
    } catch (error) {
      if (error instanceof EncryptedStorageError) {
        throw new SourceCredentialsUnreadableError(error.message);
      }
      throw error;
    }
    if (browserState === null) {
      throw new BrowserStateNotFoundError(options.source.browserStatePath);
    }
  }

  // A service can have only a preparation and no credentials yet, so both
  // sections of the store contribute to what can be re-encrypted.
  const storedServiceNames = new Set([...allCredentials.keys(), ...preparedServiceNames]);

  let selectedServiceNames: readonly string[];
  if (options.services !== undefined) {
    const missing = options.services.filter((name) => !storedServiceNames.has(name));
    if (missing.length > 0) {
      throw new ServicesNotStoredError(missing);
    }
    selectedServiceNames = options.services;
  } else {
    selectedServiceNames = [...storedServiceNames];
  }

  const account = options.account;
  if (
    account !== undefined &&
    !selectedServiceNames.some((name) => allCredentials.get(name)?.has(account) === true)
  ) {
    throw new AccountNotStoredError(account);
  }

  if (selectedServiceNames.length === 0 && browserState === null) {
    throw new NothingToReencryptError();
  }

  const destinationStorage = new EncryptedStorage(options.destination.encryptionKey);
  const destinationStore = new ApiCredentialStore(
    destinationStorePath,
    destinationStorage,
    options.apiCredentialsTypes
  );
  // Reading the destination store validates that it can be decrypted with
  // the destination key before anything is written into it.
  if (existsSync(destinationStorePath)) {
    // An existing store in an older data format would be migrated (and
    // thereby mangled) by the next Latchkey run, so refuse to add to it.
    let destinationVersion: number;
    try {
      destinationVersion = readDataFormatVersionOfDirectory(destinationDirectory);
    } catch (error) {
      if (error instanceof MigrationError) {
        throw new DestinationDataFormatError(error.message);
      }
      throw error;
    }
    if (destinationVersion !== LATEST_VERSION) {
      throw new DestinationDataFormatError(
        `The existing credential store at ${destinationStorePath} is in data format ` +
          `version ${String(destinationVersion)}, but ${String(LATEST_VERSION)} is required.`,
        'Point Latchkey at that directory to migrate it first, or choose an empty destination.'
      );
    }

    try {
      destinationStore.getAll();
    } catch (error) {
      if (error instanceof ApiCredentialStoreError || error instanceof EncryptedStorageError) {
        throw new DestinationCredentialsUnreadableError(destinationStorePath, error.message);
      }
      throw error;
    }
  }

  for (const serviceName of selectedServiceNames) {
    // Without an account filter the whole service is replaced. With one,
    // only the exported account is overwritten (by saving it below), so
    // that accounts the source does not have stay untouched.
    if (account === undefined) {
      destinationStore.deleteAll(serviceName);
    }
    const accountMap = allCredentials.get(serviceName);
    if (accountMap !== undefined) {
      for (const [storedAccount, credentials] of accountMap) {
        if (account !== undefined && storedAccount !== account) {
          continue;
        }
        destinationStore.save(serviceName, credentials, storedAccount);
      }
    }
    const preparation = sourceStore.getPreparation(serviceName);
    if (preparation !== null) {
      destinationStore.savePreparation(serviceName, preparation);
    }
  }

  let browserStateDestination: string | null = null;
  if (browserState !== null) {
    browserStateDestination = join(destinationDirectory, basename(options.source.browserStatePath));
    destinationStorage.writeFile(browserStateDestination, browserState);
  }

  // Stamp the data format version so that Latchkey does not mistake the
  // exported directory for one in the oldest format and "migrate" it.
  writeDataFormatVersionOfDirectory(destinationDirectory, LATEST_VERSION);

  return {
    services: selectedServiceNames,
    credentialStorePath: destinationStorePath,
    browserStatePath: browserStateDestination,
  };
}

/** A Latchkey directory and the key its store and browser state are encrypted with. */
export interface CredentialsLocation {
  readonly directory: string;
  readonly encryptionKey: string;
}

export interface ReencryptCredentialsOptions {
  readonly source: CredentialsLocation;
  readonly destination: CredentialsLocation;
  /** Every credential type either store can hold; pass the runtime's. */
  readonly apiCredentialsTypes: readonly ApiCredentialsType[];
  /** Only these services; every stored service when left out. */
  readonly services?: readonly string[];
  /** Only this account's credentials of each selected service. */
  readonly account?: string;
  readonly isBrowserStateIncluded?: boolean;
}

/**
 * The configuration of a bare Latchkey directory: where its files are, and
 * nothing from the environment or from its config.json.
 */
function configOfDirectory(directory: string): Config {
  return new Config(
    (name) => (name === LATCHKEY_DIRECTORY_ENV_VAR ? directory : undefined),
    () => ({})
  );
}

/**
 * Re-encrypt credentials from one Latchkey directory into another: what
 * `latchkey auth re-encrypt` does when it is run against the source directory.
 *
 * Like every run of the command line, it first migrates the directory it runs
 * against, here the source, in place, when that is in an older data format. A
 * source in a newer format than this Latchkey writes throws `MigrationError`.
 * See `reencryptCredentialFiles` for the rest.
 */
export async function reencryptCredentials(
  options: ReencryptCredentialsOptions
): Promise<ReencryptCredentialsResult> {
  const sourceConfig = configOfDirectory(options.source.directory);
  if (existsSync(sourceConfig.credentialStorePath)) {
    await runMigrations(sourceConfig, new EncryptedStorage(options.source.encryptionKey));
  }
  return reencryptCredentialFiles({
    source: {
      credentialStorePath: sourceConfig.credentialStorePath,
      browserStatePath: sourceConfig.browserStatePath,
      encryptionKey: options.source.encryptionKey,
    },
    destination: options.destination,
    apiCredentialsTypes: options.apiCredentialsTypes,
    services: options.services,
    account: options.account,
    isBrowserStateIncluded: options.isBrowserStateIncluded,
  });
}
