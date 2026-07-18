import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApiCredentialStore, ApiCredentialStoreError } from '../src/apiCredentials/store.js';
import { AuthorizationBearer, AuthorizationBare } from '../src/apiCredentials/base.js';
import { SlackApiCredentials } from '../src/services/slack.js';
import { EncryptedStorage } from '../src/encryptedStorage.js';
import { generateKey } from '../src/encryption.js';

describe('ApiCredentialStore', () => {
  let tempDir: string;
  let storePath: string;
  let encryptedStorage: EncryptedStorage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'latchkey-test-'));
    storePath = join(tempDir, 'credentials.json');
    encryptedStorage = new EncryptedStorage(generateKey());
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('get', () => {
    it('should return null for non-existent store file', () => {
      const store = new ApiCredentialStore(storePath, encryptedStorage);
      expect(store.get('slack')).toBeNull();
    });

    it('should return null for non-existent service', () => {
      const store = new ApiCredentialStore(storePath, encryptedStorage);
      store.save('discord', new AuthorizationBare('token'));
      expect(store.get('slack')).toBeNull();
    });

    it('should retrieve saved AuthorizationBearer credentials', () => {
      const store = new ApiCredentialStore(storePath, encryptedStorage);
      const credentials = new AuthorizationBearer('test-token');
      store.save('github', credentials);

      const retrieved = store.get('github');
      expect(retrieved).toBeInstanceOf(AuthorizationBearer);
      expect((retrieved as AuthorizationBearer).token).toBe('test-token');
    });

    it('should retrieve saved AuthorizationBare credentials', () => {
      const store = new ApiCredentialStore(storePath, encryptedStorage);
      const credentials = new AuthorizationBare('discord-token');
      store.save('discord', credentials);

      const retrieved = store.get('discord');
      expect(retrieved).toBeInstanceOf(AuthorizationBare);
      expect((retrieved as AuthorizationBare).token).toBe('discord-token');
    });

    it('should retrieve saved SlackApiCredentials', () => {
      const store = new ApiCredentialStore(storePath, encryptedStorage);
      const credentials = new SlackApiCredentials('xoxc-token', 'd-cookie');
      store.save('slack', credentials);

      const retrieved = store.get('slack');
      expect(retrieved).toBeInstanceOf(SlackApiCredentials);
      expect((retrieved as SlackApiCredentials).token).toBe('xoxc-token');
      expect((retrieved as SlackApiCredentials).dCookie).toBe('d-cookie');
    });

    it('should throw an error naming the remedy for a corrupt entry', () => {
      encryptedStorage.writeFile(
        storePath,
        JSON.stringify({ databricks: { objectType: 'databricksOauth', accessToken: 'stale' } })
      );
      const store = new ApiCredentialStore(storePath, encryptedStorage);

      expect(() => store.get('databricks')).toThrow(ApiCredentialStoreError);
      expect(() => store.get('databricks')).toThrow('latchkey auth clear databricks');
    });
  });

  describe('getAll', () => {
    it('should return all valid credentials with no corrupt entries', () => {
      const store = new ApiCredentialStore(storePath, encryptedStorage);
      store.save('github', new AuthorizationBearer('github-token'));
      store.save('discord', new AuthorizationBare('discord-token'));

      const { credentials, corruptEntries } = store.getAll();

      expect(credentials.size).toBe(2);
      expect(credentials.get('github')).toBeInstanceOf(AuthorizationBearer);
      expect(credentials.get('discord')).toBeInstanceOf(AuthorizationBare);
      expect(corruptEntries.size).toBe(0);
    });

    it('should report a corrupt entry and keep the valid ones', () => {
      encryptedStorage.writeFile(
        storePath,
        JSON.stringify({
          databricks: { objectType: 'databricksOauth', accessToken: 'stale' },
          github: { objectType: 'authorizationBearer', token: 'github-token' },
        })
      );
      const store = new ApiCredentialStore(storePath, encryptedStorage);

      const { credentials, corruptEntries } = store.getAll();

      expect(credentials.size).toBe(1);
      expect(credentials.get('github')).toBeInstanceOf(AuthorizationBearer);
      expect(corruptEntries.size).toBe(1);
      const corruptEntry = corruptEntries.get('databricks');
      expect(corruptEntry?.objectType).toBe('databricksOauth');
      expect(corruptEntry?.error).toContain('objectType');
    });

    it('should report a known credential type with missing fields as corrupt', () => {
      encryptedStorage.writeFile(
        storePath,
        JSON.stringify({ github: { objectType: 'authorizationBearer' } })
      );
      const store = new ApiCredentialStore(storePath, encryptedStorage);

      const { credentials, corruptEntries } = store.getAll();

      expect(credentials.size).toBe(0);
      const corruptEntry = corruptEntries.get('github');
      expect(corruptEntry?.objectType).toBe('authorizationBearer');
      expect(corruptEntry?.error).toContain('token');
    });

    it('should report a non-object entry as corrupt with a null objectType', () => {
      encryptedStorage.writeFile(storePath, JSON.stringify({ github: 'not-an-object' }));
      const store = new ApiCredentialStore(storePath, encryptedStorage);

      const { credentials, corruptEntries } = store.getAll();

      expect(credentials.size).toBe(0);
      expect(corruptEntries.get('github')?.objectType).toBeNull();
    });
  });

  describe('save', () => {
    it('should create the store file if it does not exist', () => {
      const store = new ApiCredentialStore(storePath, encryptedStorage);
      store.save('github', new AuthorizationBearer('token'));
      expect(existsSync(storePath)).toBe(true);
    });

    it('should create parent directories if they do not exist', () => {
      const nestedPath = join(tempDir, 'nested', 'deep', 'credentials.json');
      const store = new ApiCredentialStore(nestedPath, encryptedStorage);
      store.save('github', new AuthorizationBearer('token'));
      expect(existsSync(nestedPath)).toBe(true);
    });

    it('should overwrite existing credentials for the same service', () => {
      const store = new ApiCredentialStore(storePath, encryptedStorage);
      store.save('github', new AuthorizationBearer('old-token'));
      store.save('github', new AuthorizationBearer('new-token'));

      const retrieved = store.get('github');
      expect((retrieved as AuthorizationBearer).token).toBe('new-token');
    });

    it('should preserve other services when saving', () => {
      const store = new ApiCredentialStore(storePath, encryptedStorage);
      store.save('github', new AuthorizationBearer('github-token'));
      store.save('discord', new AuthorizationBare('discord-token'));

      expect(store.get('github')).not.toBeNull();
      expect(store.get('discord')).not.toBeNull();
    });

    it('should write valid JSON (encrypted)', () => {
      const store = new ApiCredentialStore(storePath, encryptedStorage);
      store.save('github', new AuthorizationBearer('token'));

      const content = readFileSync(storePath, 'utf-8');
      // When encrypted, content starts with prefix, followed by encrypted JSON
      expect(content.startsWith('LATCHKEY_ENCRYPTED:')).toBe(true);
    });
  });

  describe('delete', () => {
    it('should return false for non-existent service', () => {
      const store = new ApiCredentialStore(storePath, encryptedStorage);
      expect(store.delete('github')).toBe(false);
    });

    it('should delete existing credentials and return true', () => {
      const store = new ApiCredentialStore(storePath, encryptedStorage);
      store.save('github', new AuthorizationBearer('token'));
      expect(store.delete('github')).toBe(true);
      expect(store.get('github')).toBeNull();
    });

    it('should preserve other services when deleting', () => {
      const store = new ApiCredentialStore(storePath, encryptedStorage);
      store.save('github', new AuthorizationBearer('github-token'));
      store.save('discord', new AuthorizationBare('discord-token'));

      store.delete('github');

      expect(store.get('github')).toBeNull();
      expect(store.get('discord')).not.toBeNull();
    });
  });
});
