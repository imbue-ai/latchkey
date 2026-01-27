import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserStateStore, BrowserStateError } from '../src/browserState.js';
import { EncryptedStorage, resetEncryptedStorage } from '../src/encryptedStorage.js';
import { generateKey } from '../src/encryption.js';

describe('BrowserStateStore', () => {
  let tempDir: string;
  let encryptedStorage: EncryptedStorage;
  let testKey: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'latchkey-browser-state-test-'));
    testKey = generateKey();
    resetEncryptedStorage();
    encryptedStorage = new EncryptedStorage({
      encryptionKeyOverride: testKey,
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    resetEncryptedStorage();
  });

  describe('prepare', () => {
    it('should create a temporary file path', () => {
      const persistentPath = join(tempDir, 'browser_state.json');
      const manager = new BrowserStateStore(persistentPath, encryptedStorage);

      const tempPath = manager.prepare();

      expect(tempPath).toBeTruthy();
      expect(tempPath).toContain('latchkey-browser-state-');
      expect(tempPath).toContain('browser_state.json');

      manager.cleanup();
    });

    it('should decrypt existing state to temp file', () => {
      const persistentPath = join(tempDir, 'browser_state.json');
      const browserState = { cookies: [{ name: 'session', value: 'abc123' }] };
      const stateContent = JSON.stringify(browserState);

      // Write encrypted state
      encryptedStorage.writeFile(persistentPath, stateContent);

      const manager = new BrowserStateStore(persistentPath, encryptedStorage);
      const tempPath = manager.prepare();

      // Verify temp file contains decrypted content
      const tempContent = readFileSync(tempPath, 'utf-8');
      expect(JSON.parse(tempContent)).toEqual(browserState);

      manager.cleanup();
    });

    it('should not create temp file content if no existing state', () => {
      const persistentPath = join(tempDir, 'browser_state.json');
      const manager = new BrowserStateStore(persistentPath, encryptedStorage);

      const tempPath = manager.prepare();

      expect(existsSync(tempPath)).toBe(false);

      manager.cleanup();
    });
  });

  describe('persist', () => {
    it('should encrypt temp file content back to persistent storage', () => {
      const persistentPath = join(tempDir, 'browser_state.json');
      const manager = new BrowserStateStore(persistentPath, encryptedStorage);

      const tempPath = manager.prepare();

      // Simulate Playwright writing to temp file
      const browserState = { cookies: [{ name: 'session', value: 'xyz789' }] };
      writeFileSync(tempPath, JSON.stringify(browserState), 'utf-8');

      manager.persist();

      // Verify persistent file is encrypted
      const rawContent = readFileSync(persistentPath, 'utf-8');
      expect(rawContent).toMatch(/^LATCHKEY_ENCRYPTED:/);

      // Verify we can read back the content
      const decryptedContent = encryptedStorage.readFile(persistentPath);
      expect(JSON.parse(decryptedContent!)).toEqual(browserState);

      manager.cleanup();
    });

    it('should throw if prepare was not called', () => {
      const persistentPath = join(tempDir, 'browser_state.json');
      const manager = new BrowserStateStore(persistentPath, encryptedStorage);

      expect(() => {
        manager.persist();
      }).toThrow(BrowserStateError);
    });
  });

  describe('cleanup', () => {
    it('should remove temporary files', () => {
      const persistentPath = join(tempDir, 'browser_state.json');
      const manager = new BrowserStateStore(persistentPath, encryptedStorage);

      const tempPath = manager.prepare();

      // Create a temp file
      writeFileSync(tempPath, '{}', 'utf-8');
      expect(existsSync(tempPath)).toBe(true);

      manager.cleanup();

      expect(existsSync(tempPath)).toBe(false);
    });

    it('should be safe to call multiple times', () => {
      const persistentPath = join(tempDir, 'browser_state.json');
      const manager = new BrowserStateStore(persistentPath, encryptedStorage);

      manager.prepare();
      manager.cleanup();
      expect(() => {
        manager.cleanup();
      }).not.toThrow(); // Should not throw
    });
  });

  describe('hasState', () => {
    it('should return true if persistent state exists', () => {
      const persistentPath = join(tempDir, 'browser_state.json');
      encryptedStorage.writeFile(persistentPath, '{}');

      const manager = new BrowserStateStore(persistentPath, encryptedStorage);

      expect(manager.hasState()).toBe(true);
    });

    it('should return false if persistent state does not exist', () => {
      const persistentPath = join(tempDir, 'browser_state.json');
      const manager = new BrowserStateStore(persistentPath, encryptedStorage);

      expect(manager.hasState()).toBe(false);
    });
  });

  describe('getTempPath', () => {
    it('should return null before prepare is called', () => {
      const persistentPath = join(tempDir, 'browser_state.json');
      const manager = new BrowserStateStore(persistentPath, encryptedStorage);

      expect(manager.getTempPath()).toBeNull();
    });

    it('should return temp path after prepare is called', () => {
      const persistentPath = join(tempDir, 'browser_state.json');
      const manager = new BrowserStateStore(persistentPath, encryptedStorage);

      manager.prepare();

      expect(manager.getTempPath()).toBeTruthy();

      manager.cleanup();
    });
  });
});
