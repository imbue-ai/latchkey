/**
 * Encryption utilities for secure credential storage.
 * Uses AES-256-GCM for authenticated encryption.
 *
 * Also exposes `resolveEncryptionKey`, which returns the master key Latchkey
 * uses for encryption (and for deriving sub-keys for other purposes such as
 * signing gateway permissions-override JWTs).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DEFAULT_KEYRING_ACCOUNT_NAME, DEFAULT_KEYRING_SERVICE_NAME } from './config.js';
import { KeychainNotAvailableError, retrieveFromKeychain, storeInKeychain } from './keychain.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionError';
  }
}

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

/**
 * Common base class for encryption-key resolution problems. Catching this
 * lets callers handle all key-acquisition failures uniformly.
 */
export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionKeyError';
  }
}

export class EncryptionKeyLostError extends EncryptionKeyError {
  constructor() {
    super(
      'The encryption key was lost from the system keychain and encrypted data already exists. ' +
        'Generating a new key would make existing data unreadable. ' +
        'Restore the keychain or set LATCHKEY_ENCRYPTION_KEY, ' +
        'or delete the encrypted files and start fresh with `latchkey auth clear`.'
    );
    this.name = 'EncryptionKeyLostError';
  }
}

export class EncryptionKeyUnavailableError extends EncryptionKeyError {
  constructor() {
    super(
      'No encryption key available. ' +
        'Set LATCHKEY_ENCRYPTION_KEY or ensure system keychain is accessible.'
    );
    this.name = 'EncryptionKeyUnavailableError';
  }
}

export interface ResolveEncryptionKeyOptions {
  /**
   * If provided, this key is used as-is and the keychain is not consulted.
   */
  encryptionKeyOverride?: string | null;
  serviceName?: string;
  accountName?: string;
  /**
   * When false, refuse to generate a new encryption key if the keychain has
   * no key. Used to prevent silently replacing a lost key, which would make
   * existing encrypted data unreadable. Set to false when encrypted files
   * already exist on disk.
   */
  allowKeyGeneration?: boolean;
}

/**
 * Resolve the Latchkey master encryption key. Precedence:
 *   1. `encryptionKeyOverride` from the caller (typically
 *      `LATCHKEY_ENCRYPTION_KEY`),
 *   2. system keychain entry,
 *   3. freshly generated key, stored in the keychain (only when
 *      `allowKeyGeneration` is true).
 *
 * Throws `EncryptionKeyLostError` when the keychain has no key but generation
 * is disallowed, and `EncryptionKeyUnavailableError` when no key can be
 * obtained at all (e.g. no keychain available and no override set).
 */
export async function resolveEncryptionKey(
  options: ResolveEncryptionKeyOptions = {}
): Promise<string> {
  if (options.encryptionKeyOverride !== undefined && options.encryptionKeyOverride !== null) {
    return options.encryptionKeyOverride;
  }

  const serviceName = options.serviceName ?? DEFAULT_KEYRING_SERVICE_NAME;
  const accountName = options.accountName ?? DEFAULT_KEYRING_ACCOUNT_NAME;

  try {
    const keychainKey = await retrieveFromKeychain(serviceName, accountName);
    if (keychainKey !== null) {
      return keychainKey;
    }

    if (options.allowKeyGeneration === false) {
      throw new EncryptionKeyLostError();
    }

    const newKey = generateKey();
    await storeInKeychain(serviceName, accountName, newKey);
    return newKey;
  } catch (error) {
    if (error instanceof KeychainNotAvailableError) {
      throw new EncryptionKeyUnavailableError();
    }
    throw error;
  }
}

/**
 * Encrypt data using AES-256-GCM.
 * The key should be a base64-encoded 256-bit key.
 * Returns a base64-encoded string containing: iv + authTag + ciphertext
 */
export function encrypt(plaintext: string, keyBase64: string): string {
  try {
    const key = Buffer.from(keyBase64, 'base64');
    if (key.length !== KEY_LENGTH) {
      throw new EncryptionError(
        `Invalid key length: expected ${String(KEY_LENGTH)} bytes, got ${String(key.length)}`
      );
    }

    const iv = randomBytes(IV_LENGTH);

    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Combine: iv (12) + authTag (16) + ciphertext
    const combined = Buffer.concat([iv, authTag, ciphertext]);
    return combined.toString('base64');
  } catch (error) {
    if (error instanceof EncryptionError) {
      throw error;
    }
    throw new EncryptionError(
      `Failed to encrypt data: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Decrypt data that was encrypted with the encrypt function.
 * The key should be a base64-encoded 256-bit key.
 * Input should be a base64-encoded string containing: iv + authTag + ciphertext
 */
export function decrypt(encryptedData: string, keyBase64: string): string {
  try {
    const key = Buffer.from(keyBase64, 'base64');
    if (key.length !== KEY_LENGTH) {
      throw new DecryptionError(
        `Invalid key length: expected ${String(KEY_LENGTH)} bytes, got ${String(key.length)}`
      );
    }

    const combined = Buffer.from(encryptedData, 'base64');

    // Minimum length is iv + authTag (ciphertext can be empty for empty string)
    if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH) {
      throw new DecryptionError('Invalid encrypted data: too short');
    }

    const iv = combined.subarray(0, IV_LENGTH);
    const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (error) {
    if (error instanceof DecryptionError) {
      throw error;
    }
    throw new DecryptionError(
      `Failed to decrypt data: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Generate a cryptographically secure random 256-bit key.
 * Returns the key as a base64-encoded string.
 */
export function generateKey(): string {
  return randomBytes(KEY_LENGTH).toString('base64');
}
