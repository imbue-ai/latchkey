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
const ENCRYPTED_FILE_SUFFIX = '.enc';

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
  private key: string | null;
  private encryptionEnabled = true;
  private keyInitialized = false;
  private readonly serviceName: string;
  private readonly accountName: string;

  constructor(options: EncryptedStorageOptions = {}) {
    this.key = options.encryptionKeyOverride ?? null;
    this.serviceName = options.serviceName ?? DEFAULT_KEYRING_SERVICE_NAME;
    this.accountName = options.accountName ?? DEFAULT_KEYRING_ACCOUNT_NAME;
  }

  /**
   * Initialize the encryption key from keychain if not already set.
   * Must be called before read/write operations.
   */
  private initializeKey(): void {
    if (this.keyInitialized) {
      return;
    }
    this.keyInitialized = true;

    // If key was provided via override, use it
    if (this.key !== null) {
      this.encryptionEnabled = true;
      return;
    }

    // Check if keychain is available
    if (!isKeychainAvailable(this.serviceName, this.accountName)) {
      this.encryptionEnabled = false;
      return;
    }

    // Try to retrieve from keychain
    try {
      const keychainKey = retrieveFromKeychain(this.serviceName, this.accountName);
      if (keychainKey) {
        this.key = keychainKey;
        this.encryptionEnabled = true;
        return;
      }

      // Generate new key and store in keychain
      const newKey = generateKey();
      storeInKeychain(this.serviceName, this.accountName, newKey);
      this.key = newKey;
      this.encryptionEnabled = true;
    } catch (error) {
      if (error instanceof KeychainNotAvailableError) {
        // Fall back to unencrypted storage
        this.encryptionEnabled = false;
        return;
      }
      throw error;
    }
  }

  /**
   * Check if encryption is enabled.
   */
  isEncryptionEnabled(): boolean {
    this.initializeKey();
    return this.encryptionEnabled;
  }

  /**
   * Read and decrypt a file.
   * Uses the .enc suffix when encryption is enabled.
   */
  readFile(filePath: string): string | null {
    this.initializeKey();

    const actualPath = this.encryptionEnabled ? filePath + ENCRYPTED_FILE_SUFFIX : filePath;
    if (!existsSync(actualPath)) {
      return null;
    }

    const content = readFileSync(actualPath, 'utf-8');

    // Check if the file is encrypted
    if (content.startsWith(ENCRYPTED_FILE_PREFIX)) {
      if (!this.encryptionEnabled || this.key === null) {
        throw new EncryptedStorageError(
          'File is encrypted but encryption is not available. ' +
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
   * When encryption is enabled, the file is written with a .enc suffix.
   */
  writeFile(filePath: string, content: string): void {
    this.initializeKey();

    const actualPath = this.encryptionEnabled ? filePath + ENCRYPTED_FILE_SUFFIX : filePath;
    const dir = dirname(actualPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    // Check permissions if file already exists
    if (existsSync(actualPath)) {
      const stats = statSync(actualPath);
      const permissions = stats.mode & 0o777;
      // Reject if group or others have any access
      if ((permissions & 0o077) !== 0) {
        throw new InsecureFilePermissionsError(actualPath, permissions);
      }
    }

    let dataToWrite: string;
    if (this.encryptionEnabled && this.key !== null) {
      const encryptedData = encrypt(content, this.key);
      dataToWrite = ENCRYPTED_FILE_PREFIX + encryptedData;
    } else {
      // Fallback to unencrypted storage
      dataToWrite = content;
    }

    writeFileSync(actualPath, dataToWrite, { encoding: 'utf-8', mode: 0o600 });
  }

  /**
   * Check if a file exists and is encrypted.
   */
  isFileEncrypted(filePath: string): boolean {
    this.initializeKey();
    const actualPath = this.encryptionEnabled ? filePath + ENCRYPTED_FILE_SUFFIX : filePath;
    if (!existsSync(actualPath)) {
      return false;
    }
    const content = readFileSync(actualPath, 'utf-8');
    return content.startsWith(ENCRYPTED_FILE_PREFIX);
  }

  /**
   * Get the actual file path where data is stored.
   * Returns the encrypted path if encryption is enabled, otherwise the original path.
   */
  getActualPath(filePath: string): string {
    this.initializeKey();
    return this.encryptionEnabled ? filePath + ENCRYPTED_FILE_SUFFIX : filePath;
  }
}

/**
 * Global singleton for encrypted storage.
 */
let encryptedStorageInstance: EncryptedStorage | null = null;

/**
 * Get the global encrypted storage instance.
 */
export function getEncryptedStorage(options?: EncryptedStorageOptions): EncryptedStorage {
  encryptedStorageInstance ??= new EncryptedStorage(options);
  return encryptedStorageInstance;
}

/**
 * Reset the global encrypted storage instance (mainly for testing).
 */
export function resetEncryptedStorage(): void {
  encryptedStorageInstance = null;
}
