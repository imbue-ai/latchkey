import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  EncryptedStorage,
  resetEncryptedStorage,
  EncryptedStorageError,
} from '../src/encryptedStorage.js';
import { generateKey } from '../src/encryption.js';

describe('EncryptedStorage', () => {
  let tempDir: string;
  let testKey: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'latchkey-encrypted-test-'));
    testKey = generateKey();
    resetEncryptedStorage();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    resetEncryptedStorage();
  });

  describe('with encryption key from environment', () => {
    it('should encrypt data when LATCHKEY_ENCRYPTION_KEY is set', () => {
      const filePath = join(tempDir, 'test.json');
      const content = '{"token": "secret-value"}';

      const storage = new EncryptedStorage({
        getEnv: (name) => (name === 'LATCHKEY_ENCRYPTION_KEY' ? testKey : undefined),
      });

      storage.writeFile(filePath, content);

      // Verify the file is encrypted (starts with prefix)
      const rawContent = readFileSync(filePath, 'utf-8');
      expect(rawContent).toMatch(/^LATCHKEY_ENCRYPTED:/);
      expect(rawContent).not.toContain('secret-value');
    });

    it('should decrypt data with the same key', () => {
      const filePath = join(tempDir, 'test.json');
      const content = '{"token": "secret-value"}';

      const storage = new EncryptedStorage({
        getEnv: (name) => (name === 'LATCHKEY_ENCRYPTION_KEY' ? testKey : undefined),
      });

      storage.writeFile(filePath, content);
      const retrieved = storage.readFile(filePath);

      expect(retrieved).toBe(content);
    });

    it('should fail to decrypt with wrong key', () => {
      const filePath = join(tempDir, 'test.json');
      const content = '{"token": "secret-value"}';
      const key1 = generateKey();
      const key2 = generateKey();

      // Write with one key
      const storageWrite = new EncryptedStorage({
        getEnv: (name) => (name === 'LATCHKEY_ENCRYPTION_KEY' ? key1 : undefined),
      });
      storageWrite.writeFile(filePath, content);

      // Read with different key
      resetEncryptedStorage();
      const storageRead = new EncryptedStorage({
        getEnv: (name) => (name === 'LATCHKEY_ENCRYPTION_KEY' ? key2 : undefined),
      });

      expect(() => storageRead.readFile(filePath)).toThrow(EncryptedStorageError);
    });

    it('should report encryption is enabled', () => {
      const storage = new EncryptedStorage({
        getEnv: (name) => (name === 'LATCHKEY_ENCRYPTION_KEY' ? testKey : undefined),
      });

      expect(storage.isEncryptionEnabled()).toBe(true);
    });
  });

  describe('file permissions', () => {
    it('should set chmod 600 on written files', () => {
      const filePath = join(tempDir, 'test.json');
      const content = '{"token": "secret-value"}';

      const storage = new EncryptedStorage({
        getEnv: (name) => (name === 'LATCHKEY_ENCRYPTION_KEY' ? testKey : undefined),
      });

      storage.writeFile(filePath, content);

      // Check file permissions (600 = 0o600 = 384 in decimal)
      const stats = statSync(filePath);
      const permissions = stats.mode & 0o777;
      expect(permissions).toBe(0o600);
    });

    it('should create parent directories with chmod 700', () => {
      const nestedPath = join(tempDir, 'nested', 'deep', 'test.json');
      const content = '{"token": "secret-value"}';

      const storage = new EncryptedStorage({
        getEnv: (name) => (name === 'LATCHKEY_ENCRYPTION_KEY' ? testKey : undefined),
      });

      storage.writeFile(nestedPath, content);

      expect(existsSync(nestedPath)).toBe(true);
    });
  });

  describe('readFile', () => {
    it('should return null for non-existent file', () => {
      const filePath = join(tempDir, 'nonexistent.json');

      const storage = new EncryptedStorage({
        getEnv: (name) => (name === 'LATCHKEY_ENCRYPTION_KEY' ? testKey : undefined),
      });

      expect(storage.readFile(filePath)).toBeNull();
    });

    it('should read unencrypted files (legacy support)', () => {
      const filePath = join(tempDir, 'legacy.json');
      const content = '{"token": "legacy-value"}';

      // Write unencrypted content directly
      writeFileSync(filePath, content, 'utf-8');

      const storage = new EncryptedStorage({
        getEnv: (name) => (name === 'LATCHKEY_ENCRYPTION_KEY' ? testKey : undefined),
      });

      const retrieved = storage.readFile(filePath);
      expect(retrieved).toBe(content);
    });
  });

  describe('isFileEncrypted', () => {
    it('should return true for encrypted files', () => {
      const filePath = join(tempDir, 'test.json');
      const content = '{"token": "secret-value"}';

      const storage = new EncryptedStorage({
        getEnv: (name) => (name === 'LATCHKEY_ENCRYPTION_KEY' ? testKey : undefined),
      });

      storage.writeFile(filePath, content);

      expect(storage.isFileEncrypted(filePath)).toBe(true);
    });

    it('should return false for unencrypted files', () => {
      const filePath = join(tempDir, 'legacy.json');
      const content = '{"token": "legacy-value"}';

      writeFileSync(filePath, content, 'utf-8');

      const storage = new EncryptedStorage({
        getEnv: (name) => (name === 'LATCHKEY_ENCRYPTION_KEY' ? testKey : undefined),
      });

      expect(storage.isFileEncrypted(filePath)).toBe(false);
    });

    it('should return false for non-existent files', () => {
      const filePath = join(tempDir, 'nonexistent.json');

      const storage = new EncryptedStorage({
        getEnv: (name) => (name === 'LATCHKEY_ENCRYPTION_KEY' ? testKey : undefined),
      });

      expect(storage.isFileEncrypted(filePath)).toBe(false);
    });
  });
});
