import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AmbiguousAccountError, ApiCredentialStore } from '../src/apiCredentials/store.js';
import {
  AuthorizationBearer,
  AuthorizationBare,
  OAuthCredentials,
} from '../src/apiCredentials/base.js';
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

  describe('preparations', () => {
    it('should return null when no preparation is stored', () => {
      const store = new ApiCredentialStore(storePath, encryptedStorage);
      expect(store.getPreparation('google-gmail')).toBeNull();
    });

    it('should store and retrieve a preparation per service', () => {
      const store = new ApiCredentialStore(storePath, encryptedStorage);
      store.savePreparation('google-gmail', new OAuthCredentials('client-id', 'client-secret'));

      const retrieved = store.getPreparation('google-gmail');
      expect(retrieved).toBeInstanceOf(OAuthCredentials);
      expect((retrieved as OAuthCredentials).clientId).toBe('client-id');
      expect(store.getPreparation('google-docs')).toBeNull();
    });

    it('should overwrite a previous preparation for the same service', () => {
      const store = new ApiCredentialStore(storePath, encryptedStorage);
      store.savePreparation('google-gmail', new OAuthCredentials('old-id', 'old-secret'));
      store.savePreparation('google-gmail', new OAuthCredentials('new-id', 'new-secret'));

      expect((store.getPreparation('google-gmail') as OAuthCredentials).clientId).toBe('new-id');
    });

    it('should keep preparations separate from credentials', () => {
      const store = new ApiCredentialStore(storePath, encryptedStorage);
      store.savePreparation('google-gmail', new OAuthCredentials('client-id', 'client-secret'));

      expect(store.get('google-gmail')).toBeNull();
      expect(store.listAccounts('google-gmail')).toEqual([]);
      expect(store.getAll().has('google-gmail')).toBe(false);
    });

    it('delete without an account also removes the preparation', () => {
      const store = new ApiCredentialStore(storePath, encryptedStorage);
      store.savePreparation('google-gmail', new OAuthCredentials('client-id', 'client-secret'));
      store.save('google-gmail', new AuthorizationBearer('token'), 'user@example.com');

      expect(store.delete('google-gmail')).toBe(true);
      expect(store.get('google-gmail', 'user@example.com')).toBeNull();
      expect(store.getPreparation('google-gmail')).toBeNull();
    });

    it('delete without an account removes a preparation-only service', () => {
      const store = new ApiCredentialStore(storePath, encryptedStorage);
      store.savePreparation('google-gmail', new OAuthCredentials('client-id', 'client-secret'));

      expect(store.delete('google-gmail')).toBe(true);
      expect(store.getPreparation('google-gmail')).toBeNull();
    });

    it('delete with an explicit account keeps the preparation', () => {
      const store = new ApiCredentialStore(storePath, encryptedStorage);
      store.savePreparation('google-gmail', new OAuthCredentials('client-id', 'client-secret'));
      store.save('google-gmail', new AuthorizationBearer('token'), 'user@example.com');

      expect(store.delete('google-gmail', 'user@example.com')).toBe(true);
      expect(store.getPreparation('google-gmail')).not.toBeNull();
    });

    it('delete without an account still throws on account ambiguity, keeping the preparation', () => {
      const store = new ApiCredentialStore(storePath, encryptedStorage);
      store.savePreparation('google-gmail', new OAuthCredentials('client-id', 'client-secret'));
      store.save('google-gmail', new AuthorizationBearer('a'), 'a@example.com');
      store.save('google-gmail', new AuthorizationBearer('b'), 'b@example.com');

      expect(() => store.delete('google-gmail')).toThrow(AmbiguousAccountError);
      expect(store.getPreparation('google-gmail')).not.toBeNull();
    });
  });

  describe('accounts', () => {
    it('should store and retrieve credentials per account', () => {
      const store = new ApiCredentialStore(storePath, encryptedStorage);
      store.save('github', new AuthorizationBearer('default-token'));
      store.save('github', new AuthorizationBearer('work-token'), 'work@example.com');

      expect((store.get('github', '') as AuthorizationBearer).token).toBe('default-token');
      expect((store.get('github', 'work@example.com') as AuthorizationBearer).token).toBe(
        'work-token'
      );
      expect(store.get('github', 'missing@example.com')).toBeNull();
    });

    it('should list the accounts stored for a service', () => {
      const store = new ApiCredentialStore(storePath, encryptedStorage);
      expect(store.listAccounts('github')).toEqual([]);

      store.save('github', new AuthorizationBearer('default-token'));
      store.save('github', new AuthorizationBearer('work-token'), 'work@example.com');

      expect([...store.listAccounts('github')].sort()).toEqual(['', 'work@example.com']);
    });

    describe('implicit account resolution', () => {
      it('get returns the single account when no account is requested', () => {
        const store = new ApiCredentialStore(storePath, encryptedStorage);
        store.save('github', new AuthorizationBearer('token'), 'only@example.com');
        expect((store.get('github') as AuthorizationBearer).token).toBe('token');
      });

      it('get throws AmbiguousAccountError when several accounts exist and none is requested', () => {
        const store = new ApiCredentialStore(storePath, encryptedStorage);
        store.save('github', new AuthorizationBearer('a'), 'a@example.com');
        store.save('github', new AuthorizationBearer('b'), 'b@example.com');
        expect(() => store.get('github')).toThrow(AmbiguousAccountError);
      });

      it('save without an account updates the single existing account', () => {
        const store = new ApiCredentialStore(storePath, encryptedStorage);
        store.save('github', new AuthorizationBearer('old'), 'only@example.com');
        store.save('github', new AuthorizationBearer('new'));

        expect(store.listAccounts('github')).toEqual(['only@example.com']);
        expect((store.get('github', 'only@example.com') as AuthorizationBearer).token).toBe('new');
      });

      it('save without an account creates the default account for a new service', () => {
        const store = new ApiCredentialStore(storePath, encryptedStorage);
        store.save('github', new AuthorizationBearer('token'));
        expect(store.listAccounts('github')).toEqual(['']);
      });

      it('save without an account throws AmbiguousAccountError when several accounts exist', () => {
        const store = new ApiCredentialStore(storePath, encryptedStorage);
        store.save('github', new AuthorizationBearer('a'), 'a@example.com');
        store.save('github', new AuthorizationBearer('b'), 'b@example.com');
        expect(() => {
          store.save('github', new AuthorizationBearer('c'));
        }).toThrow(AmbiguousAccountError);
      });
    });

    describe('delete', () => {
      it('should delete a single account and keep the others', () => {
        const store = new ApiCredentialStore(storePath, encryptedStorage);
        store.save('github', new AuthorizationBearer('a'), 'a@example.com');
        store.save('github', new AuthorizationBearer('b'), 'b@example.com');

        expect(store.delete('github', 'a@example.com')).toBe(true);
        expect(store.get('github', 'a@example.com')).toBeNull();
        expect(store.get('github', 'b@example.com')).not.toBeNull();
      });

      it('should remove the service entry when its last account is deleted', () => {
        const store = new ApiCredentialStore(storePath, encryptedStorage);
        store.save('github', new AuthorizationBearer('a'), 'a@example.com');

        expect(store.delete('github', 'a@example.com')).toBe(true);
        expect(store.listAccounts('github')).toEqual([]);
      });

      it('should delete the single account when none is specified', () => {
        const store = new ApiCredentialStore(storePath, encryptedStorage);
        store.save('github', new AuthorizationBearer('a'), 'a@example.com');

        expect(store.delete('github')).toBe(true);
        expect(store.listAccounts('github')).toEqual([]);
      });

      it('should throw AmbiguousAccountError when deleting without an account and several exist', () => {
        const store = new ApiCredentialStore(storePath, encryptedStorage);
        store.save('github', new AuthorizationBearer('a'), 'a@example.com');
        store.save('github', new AuthorizationBearer('b'), 'b@example.com');
        expect(() => store.delete('github')).toThrow(AmbiguousAccountError);
      });

      it('should return false when deleting a missing account', () => {
        const store = new ApiCredentialStore(storePath, encryptedStorage);
        store.save('github', new AuthorizationBearer('a'), 'a@example.com');
        expect(store.delete('github', 'missing@example.com')).toBe(false);
      });
    });

    describe('getAll', () => {
      it('should return credentials grouped by service and account', () => {
        const store = new ApiCredentialStore(storePath, encryptedStorage);
        store.save('github', new AuthorizationBearer('default'));
        store.save('github', new AuthorizationBearer('work'), 'work@example.com');
        store.save('discord', new AuthorizationBare('discord-token'));

        const all = store.getAll();
        expect([...all.keys()].sort()).toEqual(['discord', 'github']);
        expect([...all.get('github')!.keys()].sort()).toEqual(['', 'work@example.com']);
        expect((all.get('github')!.get('work@example.com') as AuthorizationBearer).token).toBe(
          'work'
        );
      });
    });
  });
});
