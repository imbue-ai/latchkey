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
    it('should skip migrations on first installation (no directory)', async () => {
      const freshConfig = createTestConfig(join(tempDir, 'nonexistent'));
      await runMigrations(freshConfig, encryptedStorage, inconclusiveResolver);
      // Should not throw and should not create any files
      expect(existsSync(join(tempDir, 'nonexistent', 'data-format-version'))).toBe(false);
    });

    it('should skip migrations on first installation (directory exists but no credentials)', async () => {
      // tempDir exists but has no credentials file
      await runMigrations(config, encryptedStorage, inconclusiveResolver);
      expect(existsSync(join(tempDir, 'data-format-version'))).toBe(false);
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
      const store = JSON.parse(content) as Record<string, unknown>;

      // The account migration additionally wraps each entry under the default
      // account (the empty string).
      expect(store).not.toHaveProperty('google');
      expect(store['google-gmail']).toEqual({ '': googleCredentials });
      expect(store['google-calendar']).toEqual({ '': googleCredentials });
      expect(store['google-drive']).toEqual({ '': googleCredentials });
      expect(store['google-sheets']).toEqual({ '': googleCredentials });
      expect(store['google-docs']).toEqual({ '': googleCredentials });
      expect(store['google-people']).toEqual({ '': googleCredentials });
      // analytics and maps should NOT be created
      expect(store).not.toHaveProperty('google-analytics');
      expect(store).not.toHaveProperty('google-directions');
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
      const store = JSON.parse(content) as Record<string, unknown>;

      expect(store['google-drive']).toEqual({ '': existingDriveCredentials });
      expect(store['google-gmail']).toEqual({ '': googleCredentials });
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
      const store = JSON.parse(content) as Record<string, unknown>;

      expect(store.slack).toEqual({ '': slackCredentials });
    });

    it('should be a no-op when there is no "google" entry', async () => {
      const slackCredentials = { objectType: 'slack', token: 't', dCookie: 'd' };

      encryptedStorage.writeFile(
        config.credentialStorePath,
        JSON.stringify({ slack: slackCredentials })
      );

      await runMigrations(config, encryptedStorage, inconclusiveResolver);

      const content = encryptedStorage.readFile(config.credentialStorePath)!;
      const store = JSON.parse(content) as Record<string, unknown>;

      expect(store.slack).toEqual({ '': slackCredentials });
      expect(Object.keys(store)).toEqual(['slack']);
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

  describe('migration 2: introduce accounts', () => {
    it('should wrap each service credential under the default account', async () => {
      const slackCredentials = { objectType: 'slack', token: 't', dCookie: 'd' };
      const discordCredentials = { objectType: 'authorizationBare', token: 'discord' };

      encryptedStorage.writeFile(
        config.credentialStorePath,
        JSON.stringify({ slack: slackCredentials, discord: discordCredentials })
      );

      await runMigrations(config, encryptedStorage, inconclusiveResolver);

      const content = encryptedStorage.readFile(config.credentialStorePath)!;
      const store = JSON.parse(content) as Record<string, unknown>;

      expect(store.slack).toEqual({ '': slackCredentials });
      expect(store.discord).toEqual({ '': discordCredentials });
    });

    it('should produce an empty store for an empty store', async () => {
      encryptedStorage.writeFile(config.credentialStorePath, JSON.stringify({}));

      await runMigrations(config, encryptedStorage, inconclusiveResolver);

      const content = encryptedStorage.readFile(config.credentialStorePath)!;
      expect(JSON.parse(content)).toEqual({});
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

      const store = JSON.parse(
        encryptedStorage.readFile(config.credentialStorePath)!
      ) as Record<string, unknown>;

      expect(store.slack).toEqual({ 'user@example.com': slackCredentials });
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

      const store = JSON.parse(
        encryptedStorage.readFile(config.credentialStorePath)!
      ) as Record<string, unknown>;

      expect(store.slack).toEqual({ '': slackCredentials });
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

      const store = JSON.parse(
        encryptedStorage.readFile(config.credentialStorePath)!
      ) as Record<string, unknown>;

      expect(store).not.toHaveProperty('slack');
      expect(store.discord).toEqual({ 'me#1234': discordCredentials });
    });

    it('should key google credentials by the account from determineAccount()', async () => {
      // Google services validate credentials via a check endpoint that carries
      // no identity and learn the account from a separate userinfo endpoint by
      // overriding determineAccount(). This exercises the real registry
      // resolver (no injected resolver) to ensure that fallback runs during the
      // migration. The curl runner is stubbed so nothing hits the network.
      setCapturingSubprocessRunner((args: readonly string[]): CurlResult => {
        const joined = args.join(' ');
        if (joined.includes('openidconnect.googleapis.com')) {
          // determineAccount() reads the signed-in e-mail from userinfo.
          return {
            returncode: 0,
            stdout: JSON.stringify({ email: 'alice@example.com' }),
            stderr: '',
          };
        }
        // Credential check endpoint: valid (HTTP 200), but the body carries no
        // identity, so checkApiCredentials() reports a null account.
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

      const store = JSON.parse(
        encryptedStorage.readFile(config.credentialStorePath)!
      ) as Record<string, unknown>;

      expect(store['google-gmail']).toEqual({ 'alice@example.com': gmailCredentials });
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

      const store = JSON.parse(
        encryptedStorage.readFile(config.credentialStorePath)!
      ) as Record<string, unknown>;

      expect(store.slack).toEqual({ '': slackCredentials });
    });
  });
});
