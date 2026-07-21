import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Config } from '../src/config.js';
import { EncryptedStorage } from '../src/encryptedStorage.js';
import { generateKey } from '../src/encryption.js';
import {
  runMigrations,
  readDataFormatVersion,
  LATEST_VERSION,
  MigrationError,
  type CredentialResolver,
} from '../src/migrations.js';
import { ApiCredentialStatus } from '../src/apiCredentials/base.js';
import type { CredentialCheck } from '../src/services/core/base.js';
import {
  setCapturingSubprocessRunner,
  resetCapturingSubprocessRunner,
  type CurlResult,
} from '../src/curl.js';

function createTestConfig(directory: string): Config {
  return new Config((name) => {
    if (name === 'LATCHKEY_DIRECTORY') return directory;
    return undefined;
  });
}

/**
 * Resolver that never hits the network. It reports every credential as
 * inconclusive, which makes the accounts migration keep each service under the
 * default account (the pre-network behaviour these tests were written for).
 */
const inconclusiveResolver: CredentialResolver = () =>
  Promise.resolve({ status: ApiCredentialStatus.Unknown, account: null });

/**
 * Build a resolver from a fixed map of service name to credential-check result,
 * defaulting to inconclusive for anything not listed.
 */
function resolverFromMap(results: Record<string, CredentialCheck>): CredentialResolver {
  return (serviceName) =>
    Promise.resolve(results[serviceName] ?? { status: ApiCredentialStatus.Unknown, account: null });
}

describe('migrations', () => {
  let tempDir: string;
  let encryptionKey: string;
  let encryptedStorage: EncryptedStorage;
  let config: Config;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'latchkey-migration-test-'));
    encryptionKey = generateKey();
    encryptedStorage = new EncryptedStorage(encryptionKey);
    config = createTestConfig(tempDir);
  });

  afterEach(() => {
    resetCapturingSubprocessRunner();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('readDataFormatVersion', () => {
    it('should return 0 when file does not exist', () => {
      expect(readDataFormatVersion(config)).toBe(0);
    });

    it('should read version from file', () => {
      writeFileSync(join(tempDir, 'data-format-version'), '3', 'utf-8');
      expect(readDataFormatVersion(config)).toBe(3);
    });

    it('should handle whitespace in version file', () => {
      writeFileSync(join(tempDir, 'data-format-version'), ' 2 \n', 'utf-8');
      expect(readDataFormatVersion(config)).toBe(2);
    });

    it('should throw on invalid content', () => {
      writeFileSync(join(tempDir, 'data-format-version'), 'abc', 'utf-8');
      expect(() => readDataFormatVersion(config)).toThrow(MigrationError);
    });

    it('should throw on negative version', () => {
      writeFileSync(join(tempDir, 'data-format-version'), '-1', 'utf-8');
      expect(() => readDataFormatVersion(config)).toThrow(MigrationError);
    });
  });

  describe('runMigrations', () => {
    it('should skip migrations but stamp the version on first installation (no directory)', async () => {
      const freshConfig = createTestConfig(join(tempDir, 'nonexistent'));
      await runMigrations(freshConfig, encryptedStorage, inconclusiveResolver);
      // A fresh installation starts in the newest format; the version stamp
      // prevents future runs from "migrating" a store created in that format.
      expect(readDataFormatVersion(freshConfig)).toBe(LATEST_VERSION);
      expect(existsSync(join(tempDir, 'nonexistent', 'credentials.json'))).toBe(false);
    });

    it('should skip migrations but stamp the version on first installation (directory exists but no credentials)', async () => {
      // tempDir exists but has no credentials file
      await runMigrations(config, encryptedStorage, inconclusiveResolver);
      expect(readDataFormatVersion(config)).toBe(LATEST_VERSION);
    });

    it('should run migrations when credentials exist and version is 0', async () => {
      // Create a credentials store with no "google" entry
      encryptedStorage.writeFile(
        config.credentialStorePath,
        JSON.stringify({ slack: { objectType: 'slack', token: 't', dCookie: 'd' } })
      );

      await runMigrations(config, encryptedStorage, inconclusiveResolver);

      expect(readDataFormatVersion(config)).toBe(LATEST_VERSION);
    });

    it('should not run migrations when already at latest version', async () => {
      encryptedStorage.writeFile(
        config.credentialStorePath,
        JSON.stringify({ slack: { objectType: 'slack', token: 't', dCookie: 'd' } })
      );
      writeFileSync(join(tempDir, 'data-format-version'), String(LATEST_VERSION), 'utf-8');

      // Should not throw
      await runMigrations(config, encryptedStorage, inconclusiveResolver);
      expect(readDataFormatVersion(config)).toBe(LATEST_VERSION);
    });

    it('should throw when version is newer than latest', async () => {
      encryptedStorage.writeFile(
        config.credentialStorePath,
        JSON.stringify({ slack: { objectType: 'slack', token: 't', dCookie: 'd' } })
      );
      writeFileSync(join(tempDir, 'data-format-version'), String(LATEST_VERSION + 1), 'utf-8');

      await expect(runMigrations(config, encryptedStorage, inconclusiveResolver)).rejects.toThrow(
        MigrationError
      );
    });
  });

  describe('migration 1: split google credentials', () => {
    it('should replace "google" with individual service entries', async () => {
      const googleCredentials = {
        objectType: 'oauth',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        accessToken: 'test-access-token',
        refreshToken: 'test-refresh-token',
      };

      encryptedStorage.writeFile(
        config.credentialStorePath,
        JSON.stringify({ google: googleCredentials })
      );

      await runMigrations(config, encryptedStorage, inconclusiveResolver);

      const content = encryptedStorage.readFile(config.credentialStorePath)!;
      const store = JSON.parse(content) as {
        credentials: Record<string, unknown>;
        preparations: Record<string, unknown>;
      };

      // The accounts-and-preparations migration additionally wraps each entry
      // under the default account (the empty string) and derives a token-less
      // OAuth client preparation for each Google service.
      const expectedPreparation = {
        objectType: 'oauth',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
      };
      expect(store.credentials).not.toHaveProperty('google');
      for (const serviceName of [
        'google-gmail',
        'google-calendar',
        'google-drive',
        'google-sheets',
        'google-docs',
        'google-people',
      ]) {
        expect(store.credentials[serviceName]).toEqual({ '': googleCredentials });
        expect(store.preparations[serviceName]).toEqual(expectedPreparation);
      }
      // analytics and maps should NOT be created
      expect(store.credentials).not.toHaveProperty('google-analytics');
      expect(store.credentials).not.toHaveProperty('google-directions');
    });

    it('should not overwrite existing individual service credentials', async () => {
      const googleCredentials = {
        objectType: 'oauth',
        clientId: 'old-client',
        clientSecret: 'old-secret',
      };
      const existingDriveCredentials = {
        objectType: 'oauth',
        clientId: 'drive-client',
        clientSecret: 'drive-secret',
        accessToken: 'drive-token',
        refreshToken: 'drive-refresh',
      };

      encryptedStorage.writeFile(
        config.credentialStorePath,
        JSON.stringify({
          google: googleCredentials,
          'google-drive': existingDriveCredentials,
        })
      );

      await runMigrations(config, encryptedStorage, inconclusiveResolver);

      const content = encryptedStorage.readFile(config.credentialStorePath)!;
      const store = JSON.parse(content) as {
        credentials: Record<string, unknown>;
        preparations: Record<string, unknown>;
      };

      expect(store.credentials['google-drive']).toEqual({ '': existingDriveCredentials });
      // The old shared "google" credentials carry no tokens, so the
      // accounts-and-preparations migration treats them as prepared
      // placeholders.
      expect(store.credentials['google-gmail']).toBeUndefined();
      expect(store.preparations['google-gmail']).toEqual(googleCredentials);
    });

    it('should preserve non-google credentials', async () => {
      const slackCredentials = { objectType: 'slack', token: 't', dCookie: 'd' };
      const googleCredentials = {
        objectType: 'oauth',
        clientId: 'client',
        clientSecret: 'secret',
      };

      encryptedStorage.writeFile(
        config.credentialStorePath,
        JSON.stringify({
          slack: slackCredentials,
          google: googleCredentials,
        })
      );

      await runMigrations(config, encryptedStorage, inconclusiveResolver);

      const content = encryptedStorage.readFile(config.credentialStorePath)!;
      const store = JSON.parse(content) as { credentials: Record<string, unknown> };

      expect(store.credentials.slack).toEqual({ '': slackCredentials });
    });

    it('should be a no-op when there is no "google" entry', async () => {
      const slackCredentials = { objectType: 'slack', token: 't', dCookie: 'd' };

      encryptedStorage.writeFile(
        config.credentialStorePath,
        JSON.stringify({ slack: slackCredentials })
      );

      await runMigrations(config, encryptedStorage, inconclusiveResolver);

      const content = encryptedStorage.readFile(config.credentialStorePath)!;
      const store = JSON.parse(content) as { credentials: Record<string, unknown> };

      expect(store.credentials.slack).toEqual({ '': slackCredentials });
      expect(Object.keys(store.credentials)).toEqual(['slack']);
    });

    it('should update the version file after migration', async () => {
      encryptedStorage.writeFile(
        config.credentialStorePath,
        JSON.stringify({ google: { objectType: 'oauth', clientId: 'c', clientSecret: 's' } })
      );

      await runMigrations(config, encryptedStorage, inconclusiveResolver);

      const versionContent = readFileSync(join(tempDir, 'data-format-version'), 'utf-8');
      expect(versionContent).toBe(String(LATEST_VERSION));
    });
  });

  describe('migration 2: introduce accounts and separate preparations', () => {
    it('should wrap each service credential under the default account', async () => {
      const slackCredentials = { objectType: 'slack', token: 't', dCookie: 'd' };
      const discordCredentials = { objectType: 'authorizationBare', token: 'discord' };

      encryptedStorage.writeFile(
        config.credentialStorePath,
        JSON.stringify({ slack: slackCredentials, discord: discordCredentials })
      );

      await runMigrations(config, encryptedStorage, inconclusiveResolver);

      const content = encryptedStorage.readFile(config.credentialStorePath)!;
      const store = JSON.parse(content) as { credentials: Record<string, unknown> };

      expect(store.credentials.slack).toEqual({ '': slackCredentials });
      expect(store.credentials.discord).toEqual({ '': discordCredentials });
    });

    it('should produce an empty store for an empty store', async () => {
      encryptedStorage.writeFile(config.credentialStorePath, JSON.stringify({}));

      await runMigrations(config, encryptedStorage, inconclusiveResolver);

      const content = encryptedStorage.readFile(config.credentialStorePath)!;
      expect(JSON.parse(content)).toEqual({ credentials: {}, preparations: {} });
    });

    it('should key valid credentials by their resolved account', async () => {
      const slackCredentials = { objectType: 'slack', token: 't', dCookie: 'd' };

      encryptedStorage.writeFile(
        config.credentialStorePath,
        JSON.stringify({ slack: slackCredentials })
      );

      await runMigrations(
        config,
        encryptedStorage,
        resolverFromMap({
          slack: { status: ApiCredentialStatus.Valid, account: 'user@example.com' },
        })
      );

      const store = JSON.parse(encryptedStorage.readFile(config.credentialStorePath)!) as {
        credentials: Record<string, unknown>;
      };

      expect(store.credentials.slack).toEqual({ 'user@example.com': slackCredentials });
    });

    it('should keep valid credentials under the default account when the account is unknown', async () => {
      const slackCredentials = { objectType: 'slack', token: 't', dCookie: 'd' };

      encryptedStorage.writeFile(
        config.credentialStorePath,
        JSON.stringify({ slack: slackCredentials })
      );

      await runMigrations(
        config,
        encryptedStorage,
        resolverFromMap({ slack: { status: ApiCredentialStatus.Valid, account: null } })
      );

      const store = JSON.parse(encryptedStorage.readFile(config.credentialStorePath)!) as {
        credentials: Record<string, unknown>;
      };

      expect(store.credentials.slack).toEqual({ '': slackCredentials });
    });

    it('should preserve the OAuth client of dropped invalid credentials as a preparation', async () => {
      const gmailCredentials = {
        objectType: 'oauth',
        clientId: 'client',
        clientSecret: 'secret',
        accessToken: 'expired-access-token',
        refreshToken: 'expired-refresh-token',
      };

      encryptedStorage.writeFile(
        config.credentialStorePath,
        JSON.stringify({ 'google-gmail': gmailCredentials })
      );

      await runMigrations(
        config,
        encryptedStorage,
        resolverFromMap({
          'google-gmail': { status: ApiCredentialStatus.Invalid, account: null },
        })
      );

      const store = JSON.parse(encryptedStorage.readFile(config.credentialStorePath)!) as {
        credentials: Record<string, unknown>;
        preparations: Record<string, unknown>;
      };

      expect(store.credentials).not.toHaveProperty('google-gmail');
      expect(store.preparations['google-gmail']).toEqual({
        objectType: 'oauth',
        clientId: 'client',
        clientSecret: 'secret',
      });
    });

    it('should drop invalid credentials', async () => {
      const slackCredentials = { objectType: 'slack', token: 't', dCookie: 'd' };
      const discordCredentials = { objectType: 'authorizationBare', token: 'discord' };

      encryptedStorage.writeFile(
        config.credentialStorePath,
        JSON.stringify({ slack: slackCredentials, discord: discordCredentials })
      );

      await runMigrations(
        config,
        encryptedStorage,
        resolverFromMap({
          slack: { status: ApiCredentialStatus.Invalid, account: null },
          discord: { status: ApiCredentialStatus.Valid, account: 'me#1234' },
        })
      );

      const store = JSON.parse(encryptedStorage.readFile(config.credentialStorePath)!) as {
        credentials: Record<string, unknown>;
      };

      expect(store.credentials).not.toHaveProperty('slack');
      expect(store.credentials.discord).toEqual({ 'me#1234': discordCredentials });
    });

    it('should key google credentials by the account from the userinfo endpoint', async () => {
      // Google services learn both validity and the account from their
      // credential check against the OpenID userinfo endpoint. This exercises
      // the real registry resolver (no injected resolver) to ensure that path
      // runs during the migration. The curl runner is stubbed so nothing hits
      // the network; the check appends the HTTP status code as the final line
      // (via `-w '\n%{http_code}'`).
      setCapturingSubprocessRunner((args: readonly string[]): CurlResult => {
        const joined = args.join(' ');
        if (joined.includes('openidconnect.googleapis.com')) {
          return {
            returncode: 0,
            stdout: `${JSON.stringify({ email: 'alice@example.com' })}\n200`,
            stderr: '',
          };
        }
        return { returncode: 0, stdout: '{}\n200', stderr: '' };
      });

      const gmailCredentials = {
        objectType: 'oauth',
        clientId: 'client',
        clientSecret: 'secret',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      };

      encryptedStorage.writeFile(
        config.credentialStorePath,
        JSON.stringify({ 'google-gmail': gmailCredentials })
      );

      // Note: no resolver is injected, so the default registry resolver runs.
      await runMigrations(config, encryptedStorage);

      const store = JSON.parse(encryptedStorage.readFile(config.credentialStorePath)!) as {
        credentials: Record<string, unknown>;
        preparations: Record<string, unknown>;
      };

      expect(store.credentials['google-gmail']).toEqual({
        'alice@example.com': gmailCredentials,
      });
      expect(store.preparations['google-gmail']).toEqual({
        objectType: 'oauth',
        clientId: 'client',
        clientSecret: 'secret',
      });
    });

    it('should leave credentials under the default account on inconclusive checks', async () => {
      const slackCredentials = { objectType: 'slack', token: 't', dCookie: 'd' };

      encryptedStorage.writeFile(
        config.credentialStorePath,
        JSON.stringify({ slack: slackCredentials })
      );

      await runMigrations(
        config,
        encryptedStorage,
        resolverFromMap({ slack: { status: ApiCredentialStatus.Unknown, account: null } })
      );

      const store = JSON.parse(encryptedStorage.readFile(config.credentialStorePath)!) as {
        credentials: Record<string, unknown>;
      };

      expect(store.credentials.slack).toEqual({ '': slackCredentials });
    });
  });

  describe('migration 2: preparations', () => {
    async function runMigrationOn(
      store: Record<string, unknown>
    ): Promise<{ credentials: Record<string, unknown>; preparations: Record<string, unknown> }> {
      encryptedStorage.writeFile(config.credentialStorePath, JSON.stringify(store));
      await runMigrations(config, encryptedStorage, inconclusiveResolver);
      return JSON.parse(encryptedStorage.readFile(config.credentialStorePath)!) as {
        credentials: Record<string, unknown>;
        preparations: Record<string, unknown>;
      };
    }

    it('moves a token-less OAuth client (a prepared placeholder) into preparations', async () => {
      const preparedClient = { objectType: 'oauth', clientId: 'cid', clientSecret: 'csecret' };

      const store = await runMigrationOn({ 'google-gmail': preparedClient });

      expect(store.credentials).not.toHaveProperty('google-gmail');
      expect(store.preparations['google-gmail']).toEqual(preparedClient);
    });

    it('derives a token-less preparation from complete OAuth credentials', async () => {
      const fullCredentials = {
        objectType: 'oauth',
        clientId: 'cid',
        clientSecret: 'csecret',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      };

      const store = await runMigrationOn({ 'google-docs': fullCredentials });

      expect(store.credentials['google-docs']).toEqual({ '': fullCredentials });
      expect(store.preparations['google-docs']).toEqual({
        objectType: 'oauth',
        clientId: 'cid',
        clientSecret: 'csecret',
      });
    });

    it('creates no preparation for non-OAuth credentials', async () => {
      const slackCredentials = { objectType: 'slack', token: 't', dCookie: 'd' };

      const store = await runMigrationOn({ slack: slackCredentials });

      expect(store.credentials.slack).toEqual({ '': slackCredentials });
      expect(store.preparations).toEqual({});
    });
  });
});
