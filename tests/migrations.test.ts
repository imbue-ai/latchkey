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
} from '../src/migrations.js';

function createTestConfig(directory: string): Config {
  return new Config((name) => {
    if (name === 'LATCHKEY_DIRECTORY') return directory;
    return undefined;
  });
}

describe('migrations', () => {
  let tempDir: string;
  let encryptionKey: string;
  let encryptedStorage: EncryptedStorage;
  let config: Config;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'latchkey-migration-test-'));
    encryptionKey = generateKey();
    encryptedStorage = new EncryptedStorage({ encryptionKeyOverride: encryptionKey });
    config = createTestConfig(tempDir);
  });

  afterEach(() => {
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
    it('should skip migrations on first installation (no directory)', () => {
      const freshConfig = createTestConfig(join(tempDir, 'nonexistent'));
      runMigrations(freshConfig, encryptedStorage);
      // Should not throw and should not create any files
      expect(existsSync(join(tempDir, 'nonexistent', 'data-format-version'))).toBe(false);
    });

    it('should skip migrations on first installation (directory exists but no credentials)', () => {
      // tempDir exists but has no credentials file
      runMigrations(config, encryptedStorage);
      expect(existsSync(join(tempDir, 'data-format-version'))).toBe(false);
    });

    it('should run migrations when credentials exist and version is 0', () => {
      // Create a credentials store with no "google" entry
      encryptedStorage.writeFile(
        config.credentialStorePath,
        JSON.stringify({ slack: { objectType: 'slack', token: 't', dCookie: 'd' } })
      );

      runMigrations(config, encryptedStorage);

      expect(readDataFormatVersion(config)).toBe(LATEST_VERSION);
    });

    it('should not run migrations when already at latest version', () => {
      encryptedStorage.writeFile(
        config.credentialStorePath,
        JSON.stringify({ slack: { objectType: 'slack', token: 't', dCookie: 'd' } })
      );
      writeFileSync(join(tempDir, 'data-format-version'), String(LATEST_VERSION), 'utf-8');

      // Should not throw
      runMigrations(config, encryptedStorage);
      expect(readDataFormatVersion(config)).toBe(LATEST_VERSION);
    });

    it('should throw when version is newer than latest', () => {
      encryptedStorage.writeFile(
        config.credentialStorePath,
        JSON.stringify({ slack: { objectType: 'slack', token: 't', dCookie: 'd' } })
      );
      writeFileSync(join(tempDir, 'data-format-version'), String(LATEST_VERSION + 1), 'utf-8');

      expect(() => {
        runMigrations(config, encryptedStorage);
      }).toThrow(MigrationError);
    });
  });

  describe('migration 1: split google credentials', () => {
    it('should replace "google" with individual service entries', () => {
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

      runMigrations(config, encryptedStorage);

      const content = encryptedStorage.readFile(config.credentialStorePath)!;
      const store = JSON.parse(content) as Record<string, unknown>;

      expect(store).not.toHaveProperty('google');
      expect(store['google-gmail']).toEqual(googleCredentials);
      expect(store['google-calendar']).toEqual(googleCredentials);
      expect(store['google-drive']).toEqual(googleCredentials);
      expect(store['google-sheets']).toEqual(googleCredentials);
      expect(store['google-docs']).toEqual(googleCredentials);
      expect(store['google-people']).toEqual(googleCredentials);
      // analytics and maps should NOT be created
      expect(store).not.toHaveProperty('google-analytics');
      expect(store).not.toHaveProperty('google-directions');
    });

    it('should not overwrite existing individual service credentials', () => {
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

      runMigrations(config, encryptedStorage);

      const content = encryptedStorage.readFile(config.credentialStorePath)!;
      const store = JSON.parse(content) as Record<string, unknown>;

      expect(store['google-drive']).toEqual(existingDriveCredentials);
      expect(store['google-gmail']).toEqual(googleCredentials);
    });

    it('should preserve non-google credentials', () => {
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

      runMigrations(config, encryptedStorage);

      const content = encryptedStorage.readFile(config.credentialStorePath)!;
      const store = JSON.parse(content) as Record<string, unknown>;

      expect(store.slack).toEqual(slackCredentials);
    });

    it('should be a no-op when there is no "google" entry', () => {
      const slackCredentials = { objectType: 'slack', token: 't', dCookie: 'd' };

      encryptedStorage.writeFile(
        config.credentialStorePath,
        JSON.stringify({ slack: slackCredentials })
      );

      runMigrations(config, encryptedStorage);

      const content = encryptedStorage.readFile(config.credentialStorePath)!;
      const store = JSON.parse(content) as Record<string, unknown>;

      expect(store.slack).toEqual(slackCredentials);
      expect(Object.keys(store)).toEqual(['slack']);
    });

    it('should update the version file after migration', () => {
      encryptedStorage.writeFile(
        config.credentialStorePath,
        JSON.stringify({ google: { objectType: 'oauth', clientId: 'c', clientSecret: 's' } })
      );

      runMigrations(config, encryptedStorage);

      const versionContent = readFileSync(join(tempDir, 'data-format-version'), 'utf-8');
      expect(versionContent).toBe(String(LATEST_VERSION));
    });
  });
});
