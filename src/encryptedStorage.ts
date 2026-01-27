/**
 * Encrypted file storage with automatic key management.
 * Encryption keys are retrieved from:
 * 1. LATCHKEY_ENCRYPTION_KEY environment variable (if set)
 * 2. System keychain
 * 3. Generated and stored in keychain (first run)
 *
 * Falls back to unencrypted storage with chmod 600 if keychain is unavailable.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { encrypt, decrypt, generateKey, DecryptionError } from './encryption.js';
import {
  isKeychainAvailable,
  retrieveFromKeychain,
  storeInKeychain,
  KeychainNotAvailableError,
} from './keychain.js';

const LATCHKEY_ENCRYPTION_KEY_ENV_VAR = 'LATCHKEY_ENCRYPTION_KEY';
const ENCRYPTED_FILE_PREFIX = 'LATCHKEY_ENCRYPTED:';

export class EncryptedStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptedStorageError';
  }
}

export interface EncryptedStorageOptions {
  getEnv?: (name: string) => string | undefined;
}

/**
 * Manages encrypted file storage with automatic key handling.
 */
export class EncryptedStorage {
  private key: string | null = null;
  private encryptionEnabled = true;
  private readonly getEnv: (name: string) => string | undefined;

  constructor(options: EncryptedStorageOptions = {}) {
    this.getEnv = options.getEnv ?? ((name) => process.env[name]);
  }

  /**
   * Initialize the encryption key.
   * Must be called before read/write operations.
   */
  private initializeKey(): void {
    if (this.key !== null) {
      return;
    }

    // 1. Check for environment variable override
    const envKey = this.getEnv(LATCHKEY_ENCRYPTION_KEY_ENV_VAR);
    if (envKey) {
      this.key = envKey;
      this.encryptionEnabled = true;
      return;
    }

    // 2. Check if keychain is available
    if (!isKeychainAvailable()) {
      this.encryptionEnabled = false;
      return;
    }

    // 3. Try to retrieve from keychain
    try {
      const keychainKey = retrieveFromKeychain();
      if (keychainKey) {
        this.key = keychainKey;
        this.encryptionEnabled = true;
        return;
      }

      // 4. Generate new key and store in keychain
      const newKey = generateKey();
      storeInKeychain(newKey);
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
   * If the file is not encrypted (legacy or fallback), returns the content as-is.
   */
  readFile(filePath: string): string | null {
    this.initializeKey();

    if (!existsSync(filePath)) {
      return null;
    }

    const content = readFileSync(filePath, 'utf-8');

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

    // File is not encrypted (legacy or fallback mode)
    return content;
  }

  /**
   * Encrypt and write data to a file.
   * Creates parent directories and sets chmod 600.
   */
  writeFile(filePath: string, content: string): void {
    this.initializeKey();

    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    let dataToWrite: string;
    if (this.encryptionEnabled && this.key !== null) {
      const encryptedData = encrypt(content, this.key);
      dataToWrite = ENCRYPTED_FILE_PREFIX + encryptedData;
    } else {
      // Fallback to unencrypted storage
      dataToWrite = content;
    }

    writeFileSync(filePath, dataToWrite, { encoding: 'utf-8', mode: 0o600 });

    // Ensure permissions are set even if file already existed
    chmodSync(filePath, 0o600);
  }

  /**
   * Check if a file exists and is encrypted.
   */
  isFileEncrypted(filePath: string): boolean {
    if (!existsSync(filePath)) {
      return false;
    }
    const content = readFileSync(filePath, 'utf-8');
    return content.startsWith(ENCRYPTED_FILE_PREFIX);
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
