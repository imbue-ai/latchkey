/**
 * API credential store for persisting and loading API credentials.
 *
 * The store has two top-level sections:
 *
 * - "credentials": complete credentials, stored per service and, within each
 *   service, per account. An account is a string that uniquely identifies the
 *   account behind the credentials (typically an e-mail, sometimes an opaque
 *   id). The empty string denotes the "default" account (when we don't know
 *   anything more).
 * - "preparations": prepared / incomplete credentials (e.g. an OAuth client
 *   id and secret created by `auth prepare` or `auth browser-prepare`),
 *   stored per service only. A service has at most one preparation; storing a
 *   new one overwrites the previous one.
 *
 * All credential read/write methods accept an optional account. When it is
 * omitted the account is resolved from the data itself: the single stored
 * account is used, or an {@link AmbiguousAccountError} is raised when several
 * accounts exist and the caller must disambiguate.
 */

import { DEFAULT_ACCOUNT } from './account.js';
import type { ApiCredentials } from './base.js';
import {
  ApiCredentialsSchema,
  deserializeCredentials,
  serializeCredentials,
} from './serialization.js';
import { EncryptedStorage } from '../encryptedStorage.js';

export class ApiCredentialStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiCredentialStoreError';
  }
}

/**
 * Thrown when a service has more than one account stored and no account was
 * specified to disambiguate between them.
 */
export class AmbiguousAccountError extends Error {
  readonly serviceName: string;
  readonly accounts: readonly string[];

  constructor(serviceName: string, accounts: readonly string[]) {
    super(
      `Multiple accounts are stored for service '${serviceName}': ` +
        `${accounts.map((account) => `'${account}'`).join(', ')}. ` +
        'Specify which one to use with --account.'
    );
    this.name = 'AmbiguousAccountError';
    this.serviceName = serviceName;
    this.accounts = accounts;
  }
}

interface StoreData {
  // service name -> account -> serialized credentials
  credentials: Record<string, Record<string, unknown>>;
  // service name -> serialized prepared (incomplete) credentials
  preparations: Record<string, unknown>;
}

export class ApiCredentialStore {
  readonly path: string;
  private readonly encryptedStorage: EncryptedStorage;

  constructor(path: string, encryptedStorage: EncryptedStorage) {
    this.path = path;
    this.encryptedStorage = encryptedStorage;
  }

  private loadStoreData(): StoreData {
    try {
      const content = this.encryptedStorage.readFile(this.path);
      if (content === null) {
        return { credentials: {}, preparations: {} };
      }
      const parsed = JSON.parse(content) as Partial<StoreData>;
      return {
        credentials: parsed.credentials ?? {},
        preparations: parsed.preparations ?? {},
      };
    } catch (error) {
      throw new ApiCredentialStoreError(
        `Failed to read credential store: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private saveStoreData(data: StoreData): void {
    try {
      this.encryptedStorage.writeFile(this.path, JSON.stringify(data, null, 2));
    } catch (error) {
      throw new ApiCredentialStoreError(
        `Failed to write credential store: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private parseCredentials(serviceName: string, credentialData: unknown): ApiCredentials {
    const parseResult = ApiCredentialsSchema.safeParse(credentialData);
    if (!parseResult.success) {
      throw new ApiCredentialStoreError(
        `Invalid credential data for service ${serviceName}: ${parseResult.error.message}`
      );
    }
    return deserializeCredentials(parseResult.data);
  }

  /**
   * Resolve which stored account to operate on when the caller did not name
   * one. Returns null when the service has no stored accounts. Throws
   * {@link AmbiguousAccountError} when several accounts exist.
   */
  private resolveImplicitAccount(serviceName: string, accounts: readonly string[]): string | null {
    if (accounts.length === 0) {
      return null;
    }
    if (accounts.length === 1) {
      return accounts[0]!;
    }
    throw new AmbiguousAccountError(serviceName, accounts);
  }

  get(serviceName: string, account?: string): ApiCredentials | null {
    const data = this.loadStoreData();
    const serviceData = data.credentials[serviceName];
    const accounts = serviceData === undefined ? [] : Object.keys(serviceData);
    const resolvedAccount = account ?? this.resolveImplicitAccount(serviceName, accounts);
    if (resolvedAccount === null) {
      return null;
    }
    const credentialData = serviceData?.[resolvedAccount];
    if (credentialData === undefined) {
      return null;
    }
    return this.parseCredentials(serviceName, credentialData);
  }

  save(serviceName: string, apiCredentials: ApiCredentials, account?: string): void {
    const data = this.loadStoreData();
    const serviceData = data.credentials[serviceName] ?? {};
    const accounts = Object.keys(serviceData);
    // A brand-new service with no account specified defaults to the default
    // account; otherwise an unspecified account updates the single existing one
    // (and raises for ambiguity), keeping writes consistent with reads.
    const resolvedAccount =
      account ?? this.resolveImplicitAccount(serviceName, accounts) ?? DEFAULT_ACCOUNT;
    data.credentials[serviceName] = {
      ...serviceData,
      [resolvedAccount]: serializeCredentials(apiCredentials),
    };
    this.saveStoreData(data);
  }

  /**
   * Return the prepared (incomplete) credentials stored for a service, or null
   * when the service has no preparation.
   */
  getPreparation(serviceName: string): ApiCredentials | null {
    const data = this.loadStoreData();
    const preparationData = data.preparations[serviceName];
    if (preparationData === undefined) {
      return null;
    }
    return this.parseCredentials(serviceName, preparationData);
  }

  /**
   * Store prepared (incomplete) credentials for a service, overwriting any
   * previous preparation for that service.
   */
  savePreparation(serviceName: string, apiCredentials: ApiCredentials): void {
    const data = this.loadStoreData();
    data.preparations[serviceName] = serializeCredentials(apiCredentials);
    this.saveStoreData(data);
  }

  /**
   * List the accounts that have credentials stored for a service, in the order
   * they appear in the store. Returns an empty array when the service has no
   * stored credentials.
   */
  listAccounts(serviceName: string): readonly string[] {
    const data = this.loadStoreData();
    const serviceData = data.credentials[serviceName];
    return serviceData === undefined ? [] : Object.keys(serviceData);
  }

  /**
   * Return all stored credentials as a map of service name to a map of account
   * to credentials.
   */
  getAll(): ReadonlyMap<string, ReadonlyMap<string, ApiCredentials>> {
    const data = this.loadStoreData();
    const result = new Map<string, ReadonlyMap<string, ApiCredentials>>();
    for (const [serviceName, serviceData] of Object.entries(data.credentials)) {
      const accountMap = new Map<string, ApiCredentials>();
      for (const [account, credentialData] of Object.entries(serviceData)) {
        accountMap.set(account, this.parseCredentials(serviceName, credentialData));
      }
      result.set(serviceName, accountMap);
    }
    return result;
  }

  /**
   * Delete stored credentials for the given account (resolving an unspecified
   * account the same way reads do). If that leaves the service with no
   * accounts, the service entry is removed entirely. When no account is
   * specified, the service's preparation (if any) is deleted as well. Returns
   * whether anything was deleted.
   */
  delete(serviceName: string, account?: string): boolean {
    const data = this.loadStoreData();
    const serviceData = data.credentials[serviceName] ?? {};
    const accounts = Object.keys(serviceData);
    // May throw AmbiguousAccountError, in which case nothing is deleted.
    const resolvedAccount = account ?? this.resolveImplicitAccount(serviceName, accounts);

    const credentialsDeleted = resolvedAccount !== null && resolvedAccount in serviceData;
    let credentials = data.credentials;
    if (credentialsDeleted) {
      const { [resolvedAccount]: _, ...remainingAccounts } = serviceData;
      if (Object.keys(remainingAccounts).length === 0) {
        const { [serviceName]: __, ...remainingServices } = credentials;
        credentials = remainingServices;
      } else {
        credentials = { ...credentials, [serviceName]: remainingAccounts };
      }
    }

    // Without an explicit account the caller means "clear this service", which
    // includes any prepared credentials.
    const preparationDeleted = account === undefined && serviceName in data.preparations;
    let preparations = data.preparations;
    if (preparationDeleted) {
      const { [serviceName]: _, ...remainingPreparations } = preparations;
      preparations = remainingPreparations;
    }

    if (!credentialsDeleted && !preparationDeleted) {
      return false;
    }
    this.saveStoreData({ credentials, preparations });
    return true;
  }
}
