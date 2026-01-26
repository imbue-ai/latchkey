/**
 * API credential store for persisting and loading API credentials.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ApiCredentials,
  ApiCredentialsSchema,
  deserializeCredentials,
  serializeCredentials,
} from './apiCredentials.js';

export class ApiCredentialStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiCredentialStoreError';
  }
}

type StoreData = Record<string, unknown>;

export class ApiCredentialStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  private loadStoreData(): StoreData {
    if (!existsSync(this.path)) {
      return {};
    }
    try {
      const content = readFileSync(this.path, 'utf-8');
      return JSON.parse(content) as StoreData;
    } catch (error) {
      throw new ApiCredentialStoreError(
        `Failed to read credential store: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private saveStoreData(data: StoreData): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    try {
      writeFileSync(this.path, JSON.stringify(data, null, 2), 'utf-8');
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

  delete(serviceName: string): boolean {
    const data = this.loadStoreData();
    if (!(serviceName in data)) {
      return false;
    }
    delete data[serviceName];
    this.saveStoreData(data);
    return true;
  }
}
