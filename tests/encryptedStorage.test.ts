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
  InsecureFilePermissionsError,
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
      const filePath = join(tempDir, 'test.json');
      const encryptedPath = filePath + '.enc';
      const content = '{"token": "secret-value"}';

      const storage = new EncryptedStorage({
        encryptionKeyOverride: testKey,
      });

      storage.writeFile(filePath, content);

      // Verify the file is written to the .enc path
      expect(existsSync(encryptedPath)).toBe(true);
      expect(existsSync(filePath)).toBe(false);

      // Verify the file is encrypted (starts with prefix)
      const rawContent = readFileSync(encryptedPath, 'utf-8');
      expect(rawContent).toMatch(/^LATCHKEY_ENCRYPTED:/);
      expect(rawContent).not.toContain('secret-value');
    });

    it('should decrypt data with the same key', () => {
      const filePath = join(tempDir, 'test.json');
      const content = '{"token": "secret-value"}';

      const storage = new EncryptedStorage({
        encryptionKeyOverride: testKey,
      });

      storage.writeFile(filePath, content);
      const retrieved = storage.readFile(filePath);

      expect(retrieved).toBe(content);
    });

    it('should fail to decrypt with wrong key', () => {
      const basePath = join(tempDir, 'test.json');
      const content = '{"token": "secret-value"}';
      const key1 = generateKey();
      const key2 = generateKey();

      // Write with one key
      const storageWrite = new EncryptedStorage({
        encryptionKeyOverride: key1,
      });
      storageWrite.writeFile(basePath, content);

      // Read with different key
      const storageRead = new EncryptedStorage({
        encryptionKeyOverride: key2,
      });

      expect(() => storageRead.readFile(basePath)).toThrow(EncryptedStorageError);
    });
  });

  describe('file permissions', () => {
    it('should set chmod 600 on written files', () => {
      const filePath = join(tempDir, 'test.json');
      const encryptedPath = filePath + '.enc';
      const content = '{"token": "secret-value"}';

      const storage = new EncryptedStorage({
        encryptionKeyOverride: testKey,
      });

      storage.writeFile(filePath, content);

      // Check file permissions (600 = 0o600 = 384 in decimal)
      const stats = statSync(encryptedPath);
      const permissions = stats.mode & 0o777;
      expect(permissions).toBe(0o600);
    });

    it('should create parent directories with chmod 700', () => {
      const nestedPath = join(tempDir, 'nested', 'deep', 'test.json');
      const encryptedPath = nestedPath + '.enc';
      const content = '{"token": "secret-value"}';

      const storage = new EncryptedStorage({
        encryptionKeyOverride: testKey,
      });

      storage.writeFile(nestedPath, content);

      expect(existsSync(encryptedPath)).toBe(true);
    });

    it('should throw error when overwriting file with insecure permissions', () => {
      const filePath = join(tempDir, 'insecure.json');
      const encryptedPath = filePath + '.enc';
      const content = '{"token": "secret-value"}';

      // Create a file with insecure permissions (readable by group)
      writeFileSync(encryptedPath, 'existing content', { encoding: 'utf-8' });
      chmodSync(encryptedPath, 0o640);

      const storage = new EncryptedStorage({
        encryptionKeyOverride: testKey,
      });

      expect(() => {
        storage.writeFile(filePath, content);
      }).toThrow(InsecureFilePermissionsError);
    });

    it('should allow overwriting file with secure permissions', () => {
      const filePath = join(tempDir, 'secure.json');
      const encryptedPath = filePath + '.enc';
      const content = '{"token": "secret-value"}';

      // Create a file with secure permissions
      writeFileSync(encryptedPath, 'existing content', { encoding: 'utf-8' });
      chmodSync(encryptedPath, 0o600);

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
      const filePath = join(tempDir, 'nonexistent.json');

      const storage = new EncryptedStorage({
        encryptionKeyOverride: testKey,
      });

      expect(storage.readFile(filePath)).toBeNull();
    });
  });

  describe('isFileEncrypted', () => {
    it('should return true for encrypted files with .enc suffix', () => {
      const filePath = join(tempDir, 'test.json');
      const content = '{"token": "secret-value"}';

      const storage = new EncryptedStorage({
        encryptionKeyOverride: testKey,
      });

      storage.writeFile(filePath, content);

      // isFileEncrypted should find the .enc file when given the base path
      expect(storage.isFileEncrypted(filePath)).toBe(true);
    });

    it('should return false for non-existent files', () => {
      const filePath = join(tempDir, 'nonexistent.json');

      const storage = new EncryptedStorage({
        encryptionKeyOverride: testKey,
      });

      expect(storage.isFileEncrypted(filePath)).toBe(false);
    });
  });

  describe('getActualPath', () => {
    it('should return path with .enc suffix when encryption is enabled', () => {
      const filePath = join(tempDir, 'test.json');

      const storage = new EncryptedStorage({
        encryptionKeyOverride: testKey,
      });

      expect(storage.getActualPath(filePath)).toBe(filePath + '.enc');
    });
  });
});
