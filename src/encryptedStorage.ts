/**
 * Encrypted file storage with automatic key management.
 * Encryption keys are retrieved from:
 * 1. Provided encryptionKeyOverride option
 * 2. System keychain
 * 3. Generated and stored in keychain (first run)
 *
 * Falls back to unencrypted storage with chmod 600 if keychain is unavailable.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_KEYRING_SERVICE_NAME, DEFAULT_KEYRING_ACCOUNT_NAME } from './config.js';
import { encrypt, decrypt, generateKey, DecryptionError } from './encryption.js';
import {
  isKeychainAvailable,
  retrieveFromKeychain,
  storeInKeychain,
  KeychainNotAvailableError,
} from './keychain.js';

const ENCRYPTED_FILE_PREFIX = 'LATCHKEY_ENCRYPTED:';

export class EncryptedStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptedStorageError';
  }
}

export class InsecureFilePermissionsError extends Error {
  constructor(filePath: string, permissions: number) {
    const permissionsOctal = permissions.toString(8).padStart(3, '0');
    super(
      `File ${filePath} has insecure permissions (${permissionsOctal}). ` +
        'Credentials files should not be readable by group or others.'
    );
    this.name = 'InsecureFilePermissionsError';
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
  private readonly key: string | null;

  constructor(options: EncryptedStorageOptions = {}) {
    this.key = EncryptedStorage.initializeKey(options);
  }

  private static initializeKey(options: EncryptedStorageOptions): string | null {
    // If key was provided via override, use it
    if (options.encryptionKeyOverride !== undefined && options.encryptionKeyOverride !== null) {
      return options.encryptionKeyOverride;
    }

    const serviceName = options.serviceName ?? DEFAULT_KEYRING_SERVICE_NAME;
    const accountName = options.accountName ?? DEFAULT_KEYRING_ACCOUNT_NAME;

    // Check if keychain is available
    if (!isKeychainAvailable(serviceName, accountName)) {
      return null;
    }

    // Try to retrieve from keychain
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
        // Fall back to unencrypted storage
        return null;
      }
      throw error;
    }
  }

  private isEncryptionEnabled(): boolean {
    return this.key !== null;
  }

  /**
   * Read and decrypt a file.
   */
  readFile(filePath: string): string | null {
    if (!existsSync(filePath)) {
      return null;
    }

    const content = readFileSync(filePath, 'utf-8');

    // Check if the file is encrypted
    if (content.startsWith(ENCRYPTED_FILE_PREFIX)) {
      if (this.key === null) {
        throw new EncryptedStorageError(
          'File is encrypted but a key is not available. ' +
            'Set LATCHKEY_ENCRYPTION_KEY or ensure system keychain is accessible.'
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

    // File is not encrypted (fallback mode when keychain unavailable)
    return content;
  }

  /**
   * Encrypt and write data to a file.
   * Creates parent directories. New files are created with chmod 600.
   * Existing files must have restrictive permissions (no group/other access).
   */
  writeFile(filePath: string, content: string): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    // Check permissions if file already exists
    if (existsSync(filePath)) {
      const stats = statSync(filePath);
      const permissions = stats.mode & 0o777;
      // Reject if group or others have any access
      if ((permissions & 0o077) !== 0) {
        throw new InsecureFilePermissionsError(filePath, permissions);
      }
    }

    let dataToWrite: string;
    if (this.key !== null) {
      const encryptedData = encrypt(content, this.key);
      dataToWrite = ENCRYPTED_FILE_PREFIX + encryptedData;
    } else {
      // Fallback to unencrypted storage
      dataToWrite = content;
    }

    writeFileSync(filePath, dataToWrite, { encoding: 'utf-8', mode: 0o600 });
  }
}
