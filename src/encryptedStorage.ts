/**
 * Encrypted file storage. The master encryption key is resolved by
 * `resolveEncryptionKey` (see `encryption.ts`), which handles the keychain /
 * override / generate-on-first-run logic. This module only deals with
 * reading and writing encrypted files.
 */

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeFileAtomic } from './atomicWrite.js';
import { decrypt, DecryptionError, encrypt } from './encryption.js';

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

/**
 * Read and write encrypted files using a pre-resolved master key. Use
 * `resolveEncryptionKey` (from `encryption.ts`) to obtain the key from the
 * keychain / environment / generation-on-first-run logic, then construct
 * `EncryptedStorage` directly.
 */
export class EncryptedStorage {
  private readonly key: string;

  constructor(key: string) {
    this.key = key;
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

    writeFileAtomic(filePath, dataToWrite, { encoding: 'utf-8', mode: 0o600 });
  }
}
