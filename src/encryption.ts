/**
 * Encryption utilities for secure credential storage.
 * Uses AES-256-GCM for authenticated encryption.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

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
