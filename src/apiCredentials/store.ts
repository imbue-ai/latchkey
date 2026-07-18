/**
 * API credential store for persisting and loading API credentials.
 */

import type { ZodError } from 'zod';
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

type StoreData = Record<string, unknown>;

/** A store entry whose data does not match any known credential schema. */
export interface BrokenCredentialEntry {
  /** The entry's claimed objectType, or null when it is missing or not a string. */
  readonly objectType: string | null;
  readonly error: string;
}

export interface CredentialStoreListing {
  readonly credentials: ReadonlyMap<string, ApiCredentials>;
  readonly brokenEntries: ReadonlyMap<string, BrokenCredentialEntry>;
}

function formatSchemaIssues(error: ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message
    )
    .join('; ');
}

function extractObjectType(credentialData: unknown): string | null {
  if (
    typeof credentialData === 'object' &&
    credentialData !== null &&
    'objectType' in credentialData &&
    typeof (credentialData as { objectType: unknown }).objectType === 'string'
  ) {
    return (credentialData as { objectType: string }).objectType;
  }
  return null;
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
        `Invalid credential data for service ${serviceName}: ${formatSchemaIssues(parseResult.error)}. ` +
          `Run 'latchkey auth clear ${serviceName}' to remove the corrupt entry.`
      );
    }

    return deserializeCredentials(parseResult.data);
  }

  save(serviceName: string, apiCredentials: ApiCredentials): void {
    const data = this.loadStoreData();
    data[serviceName] = serializeCredentials(apiCredentials);
    this.saveStoreData(data);
  }

  /**
   * Load all entries, parsing each one independently: entries that do not match
   * any known credential schema are returned in brokenEntries.
   */
  getAll(): CredentialStoreListing {
    const data = this.loadStoreData();
    const credentials = new Map<string, ApiCredentials>();
    const brokenEntries = new Map<string, BrokenCredentialEntry>();
    for (const [serviceName, credentialData] of Object.entries(data)) {
      const parseResult = ApiCredentialsSchema.safeParse(credentialData);
      if (!parseResult.success) {
        brokenEntries.set(serviceName, {
          objectType: extractObjectType(credentialData),
          error: formatSchemaIssues(parseResult.error),
        });
        continue;
      }
      credentials.set(serviceName, deserializeCredentials(parseResult.data));
    }
    return { credentials, brokenEntries };
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
