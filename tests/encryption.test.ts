import { describe, it, expect } from 'vitest';
import {
  encrypt,
  decrypt,
  generateKey,
  DecryptionError,
  EncryptionError,
} from '../src/encryption.js';

describe('encryption', () => {
  describe('encrypt/decrypt roundtrip', () => {
    it('should encrypt and decrypt a simple string', () => {
      const key = generateKey();
      const plaintext = 'Hello, World!';

      const encrypted = encrypt(plaintext, key);
      const decrypted = decrypt(encrypted, key);

      expect(decrypted).toBe(plaintext);
    });

    it('should encrypt and decrypt unicode characters', () => {
      const key = generateKey();
      const plaintext = '日本語 🎉 émojis and ünïcödé';

      const encrypted = encrypt(plaintext, key);
      const decrypted = decrypt(encrypted, key);

      expect(decrypted).toBe(plaintext);
    });

    it('should encrypt and decrypt empty string', () => {
      const key = generateKey();
      const plaintext = '';

      const encrypted = encrypt(plaintext, key);
      const decrypted = decrypt(encrypted, key);

      expect(decrypted).toBe(plaintext);
    });
  });

  describe('encrypt', () => {
    it('should produce different ciphertext for same plaintext (due to random IV)', () => {
      const key = generateKey();
      const plaintext = 'Hello, World!';

      const encrypted1 = encrypt(plaintext, key);
      const encrypted2 = encrypt(plaintext, key);

      expect(encrypted1).not.toBe(encrypted2);
    });

    it('should produce base64 output', () => {
      const key = generateKey();
      const plaintext = 'Hello, World!';

      const encrypted = encrypt(plaintext, key);

      // Base64 only contains alphanumeric, +, /, and = characters
      expect(encrypted).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });

    it('should fail with invalid key length', () => {
      const shortKey = Buffer.from('too-short').toString('base64');
      const plaintext = 'Hello, World!';

      expect(() => encrypt(plaintext, shortKey)).toThrow(EncryptionError);
    });
  });

  describe('decrypt', () => {
    it('should fail with wrong key', () => {
      const key1 = generateKey();
      const key2 = generateKey();
      const plaintext = 'Hello, World!';
      const encrypted = encrypt(plaintext, key1);

      expect(() => decrypt(encrypted, key2)).toThrow(DecryptionError);
    });

    it('should fail with corrupted data', () => {
      const key = generateKey();
      const plaintext = 'Hello, World!';
      const encrypted = encrypt(plaintext, key);

      // Corrupt the encrypted data
      const corrupted = encrypted.slice(0, -5) + 'xxxxx';

      expect(() => decrypt(corrupted, key)).toThrow(DecryptionError);
    });

    it('should fail with too short data', () => {
      const key = generateKey();

      expect(() => decrypt('dG9vIHNob3J0', key)).toThrow(DecryptionError);
    });

    it('should fail with invalid key length', () => {
      const key = generateKey();
      const shortKey = Buffer.from('too-short').toString('base64');
      const plaintext = 'Hello, World!';
      const encrypted = encrypt(plaintext, key);

      expect(() => decrypt(encrypted, shortKey)).toThrow(DecryptionError);
    });
  });

  describe('generateKey', () => {
    it('should generate a 256-bit key', () => {
      const key = generateKey();
      const decoded = Buffer.from(key, 'base64');

      expect(decoded.length).toBe(32);
    });

    it('should generate different keys each time', () => {
      const key1 = generateKey();
      const key2 = generateKey();

      expect(key1).not.toBe(key2);
    });
  });
});
