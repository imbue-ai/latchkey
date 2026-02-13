/**
 * Encrypted file storage with automatic key management.
 * Encryption keys are retrieved from:
 * 1. Provided encryptionKeyOverride option
 * 2. System keychain
 * 3. Generated and stored in keychain (first run)
 *
 * Throws if neither a system keychain nor LATCHKEY_ENCRYPTION_KEY is available.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_KEYRING_SERVICE_NAME, DEFAULT_KEYRING_ACCOUNT_NAME } from './config.js';
import { encrypt, decrypt, generateKey, DecryptionError } from './encryption.js';
import { retrieveFromKeychain, storeInKeychain, KeychainNotAvailableError } from './keychain.js';

const ENCRYPTED_FILE_PREFIX = 'LATCHKEY_ENCRYPTED:';

export class EncryptedStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptedStorageError';
  }
}

export class PathIsDirectoryError extends Error {
  constructor(filePath: string) {
    super(`Path is a directory, not a file: ${filePath}`);
    this.name = 'PathIsDirectoryError';
  }
}

export interface EncryptedStorageOptions {
  encryptionKeyOverride?: string | null;
  serviceName?: string;
  accountName?: string;
}

/**
 * Manages encrypted file storage with automatic key handling.
 */
export class EncryptedStorage {
  private readonly key: string;

  constructor(options: EncryptedStorageOptions = {}) {
    this.key = EncryptedStorage.initializeKey(options);
  }

  private static initializeKey(options: EncryptedStorageOptions): string {
    // If key was provided via override, use it
    if (options.encryptionKeyOverride !== undefined && options.encryptionKeyOverride !== null) {
      return options.encryptionKeyOverride;
    }

    const serviceName = options.serviceName ?? DEFAULT_KEYRING_SERVICE_NAME;
    const accountName = options.accountName ?? DEFAULT_KEYRING_ACCOUNT_NAME;

    try {
      const keychainKey = retrieveFromKeychain(serviceName, accountName);
      if (keychainKey) {
        return keychainKey;
      }

      // Generate new key and store in keychain
      const newKey = generateKey();
      storeInKeychain(serviceName, accountName, newKey);
      return newKey;
    } catch (error) {
      if (error instanceof KeychainNotAvailableError) {
        throw new EncryptedStorageError(
          'No encryption key available. ' +
            'Set LATCHKEY_ENCRYPTION_KEY or ensure system keychain is accessible.'
        );
      }
      throw error;
    }
  }

  /**
   * Read and decrypt a file.
   */
  readFile(filePath: string): string | null {
    if (!existsSync(filePath)) {
      return null;
    }

    const stats = statSync(filePath);
    if (stats.isDirectory()) {
      throw new PathIsDirectoryError(filePath);
    }

    const content = readFileSync(filePath, 'utf-8');

    if (!content.startsWith(ENCRYPTED_FILE_PREFIX)) {
      throw new EncryptedStorageError(
        `File is not encrypted: ${filePath}. ` +
          'Latchkey requires all stored data to be encrypted.'
      );
    }

    const encryptedData = content.slice(ENCRYPTED_FILE_PREFIX.length);
    try {
      return decrypt(encryptedData, this.key);
    } catch (error) {
      if (error instanceof DecryptionError) {
        throw new EncryptedStorageError(
          `Failed to decrypt file: ${error.message}. ` + 'The encryption key may have changed.'
        );
      }
      throw error;
    }
  }

  /**
   * Encrypt and write data to a file.
   * Creates parent directories. New files are created with chmod 600.
   */
  writeFile(filePath: string, content: string): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    if (existsSync(filePath)) {
      const stats = statSync(filePath);
      if (stats.isDirectory()) {
        throw new PathIsDirectoryError(filePath);
      }
    }

    const encryptedData = encrypt(content, this.key);
    const dataToWrite = ENCRYPTED_FILE_PREFIX + encryptedData;

    writeFileSync(filePath, dataToWrite, { encoding: 'utf-8', mode: 0o600 });
  }
}
