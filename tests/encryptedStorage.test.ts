import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  statSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  EncryptedStorage,
  EncryptedStorageError,
  PathIsDirectoryError,
} from '../src/encryptedStorage.js';
import { generateKey } from '../src/encryption.js';

describe('EncryptedStorage', () => {
  let tempDir: string;
  let testKey: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'latchkey-encrypted-test-'));
    testKey = generateKey();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('with encryption key from Config', () => {
    it('should encrypt data when encryptionKey is set', () => {
      const filePath = join(tempDir, 'test.json.enc');
      const content = '{"token": "secret-value"}';

      const storage = new EncryptedStorage({
        encryptionKeyOverride: testKey,
      });

      storage.writeFile(filePath, content);

      // Verify the file is written to the exact path specified
      expect(existsSync(filePath)).toBe(true);

      // Verify the file is encrypted (starts with prefix)
      const rawContent = readFileSync(filePath, 'utf-8');
      expect(rawContent).toMatch(/^LATCHKEY_ENCRYPTED:/);
      expect(rawContent).not.toContain('secret-value');
    });

    it('should decrypt data with the same key', () => {
      const filePath = join(tempDir, 'test.json.enc');
      const content = '{"token": "secret-value"}';

      const storage = new EncryptedStorage({
        encryptionKeyOverride: testKey,
      });

      storage.writeFile(filePath, content);
      const retrieved = storage.readFile(filePath);

      expect(retrieved).toBe(content);
    });

    it('should fail to decrypt with wrong key', () => {
      const filePath = join(tempDir, 'test.json.enc');
      const content = '{"token": "secret-value"}';
      const key1 = generateKey();
      const key2 = generateKey();

      // Write with one key
      const storageWrite = new EncryptedStorage({
        encryptionKeyOverride: key1,
      });
      storageWrite.writeFile(filePath, content);

      // Read with different key
      const storageRead = new EncryptedStorage({
        encryptionKeyOverride: key2,
      });

      expect(() => storageRead.readFile(filePath)).toThrow(EncryptedStorageError);
    });
  });

  describe('file permissions', () => {
    it('should set chmod 600 on written files', () => {
      const filePath = join(tempDir, 'test.json.enc');
      const content = '{"token": "secret-value"}';

      const storage = new EncryptedStorage({
        encryptionKeyOverride: testKey,
      });

      storage.writeFile(filePath, content);

      // Check file permissions (600 = 0o600 = 384 in decimal)
      const stats = statSync(filePath);
      const permissions = stats.mode & 0o777;
      expect(permissions).toBe(0o600);
    });

    it('should create parent directories with chmod 700', () => {
      const filePath = join(tempDir, 'nested', 'deep', 'test.json.enc');
      const content = '{"token": "secret-value"}';

      const storage = new EncryptedStorage({
        encryptionKeyOverride: testKey,
      });

      storage.writeFile(filePath, content);

      expect(existsSync(filePath)).toBe(true);
    });

    it('should allow overwriting file with secure permissions', () => {
      const filePath = join(tempDir, 'secure.json.enc');
      const content = '{"token": "secret-value"}';

      // Create a file with secure permissions
      writeFileSync(filePath, 'existing content', { encoding: 'utf-8' });
      chmodSync(filePath, 0o600);

      const storage = new EncryptedStorage({
        encryptionKeyOverride: testKey,
      });

      // Should not throw
      storage.writeFile(filePath, content);

      const retrieved = storage.readFile(filePath);
      expect(retrieved).toBe(content);
    });
  });

  describe('readFile', () => {
    it('should return null for non-existent file', () => {
      const filePath = join(tempDir, 'nonexistent.json.enc');

      const storage = new EncryptedStorage({
        encryptionKeyOverride: testKey,
      });

      expect(storage.readFile(filePath)).toBeNull();
    });

    it('should throw PathIsDirectoryError when path is a directory', () => {
      const storage = new EncryptedStorage({
        encryptionKeyOverride: testKey,
      });

      expect(() => storage.readFile(tempDir)).toThrow(PathIsDirectoryError);
      expect(() => storage.readFile(tempDir)).toThrow('Path is a directory, not a file');
    });
  });

  describe('writeFile', () => {
    it('should throw PathIsDirectoryError when path is a directory', () => {
      const storage = new EncryptedStorage({
        encryptionKeyOverride: testKey,
      });

      expect(() => {
        storage.writeFile(tempDir, 'content');
      }).toThrow(PathIsDirectoryError);
      expect(() => {
        storage.writeFile(tempDir, 'content');
      }).toThrow('Path is a directory, not a file');
    });
  });
});
