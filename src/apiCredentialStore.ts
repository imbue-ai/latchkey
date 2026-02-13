/**
 * API credential store for persisting and loading API credentials.
 */

import {
  ApiCredentials,
  ApiCredentialsSchema,
  deserializeCredentials,
  serializeCredentials,
} from './apiCredentials.js';
import { EncryptedStorage } from './encryptedStorage.js';

export class ApiCredentialStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiCredentialStoreError';
  }
}

type StoreData = Record<string, unknown>;

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
        return {};
      }
      return JSON.parse(content) as StoreData;
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

  get(serviceName: string): ApiCredentials | null {
    const data = this.loadStoreData();
    const credentialData = data[serviceName];
    if (credentialData === undefined) {
      return null;
    }

    const parseResult = ApiCredentialsSchema.safeParse(credentialData);
    if (!parseResult.success) {
      throw new ApiCredentialStoreError(
        `Invalid credential data for service ${serviceName}: ${parseResult.error.message}`
      );
    }

    return deserializeCredentials(parseResult.data);
  }

  save(serviceName: string, apiCredentials: ApiCredentials): void {
    const data = this.loadStoreData();
    data[serviceName] = serializeCredentials(apiCredentials);
    this.saveStoreData(data);
  }

  getAll(): ReadonlyMap<string, ApiCredentials> {
    const data = this.loadStoreData();
    const result = new Map<string, ApiCredentials>();
    for (const [serviceName, credentialData] of Object.entries(data)) {
      const parseResult = ApiCredentialsSchema.safeParse(credentialData);
      if (!parseResult.success) {
        throw new ApiCredentialStoreError(
          `Invalid credential data for service ${serviceName}: ${parseResult.error.message}`
        );
      }
      result.set(serviceName, deserializeCredentials(parseResult.data));
    }
    return result;
  }

  delete(serviceName: string): boolean {
    const data = this.loadStoreData();
    if (!(serviceName in data)) {
      return false;
    }
    const { [serviceName]: _, ...rest } = data;
    this.saveStoreData(rest);
    return true;
  }
}
