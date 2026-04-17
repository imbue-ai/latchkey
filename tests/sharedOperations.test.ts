import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EncryptedStorage } from '../src/encryptedStorage.js';
import { ApiCredentialStore } from '../src/apiCredentialStore.js';
import { ApiCredentialStatus } from '../src/apiCredentials.js';
import { SlackApiCredentials } from '../src/services/slack.js';
import { NoCurlCredentialsNotSupportedError, Service } from '../src/services/core/base.js';
import { RegisteredService } from '../src/services/core/registered.js';
import { Registry } from '../src/registry.js';
import { Config } from '../src/config.js';
import {
  servicesList,
  servicesInfo,
  authList,
  authBrowser,
  authBrowserPrepare,
  UnknownServiceError,
  PreparationRequiredError,
} from '../src/sharedOperations.js';
import { BrowserFlowsNotSupportedError } from '../src/playwrightUtils.js';

const TEST_ENCRYPTION_KEY = 'dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleXRlc3Q=';

async function writeSecureFile(path: string, content: string): Promise<void> {
  const storage = await EncryptedStorage.create({ encryptionKeyOverride: TEST_ENCRYPTION_KEY });
  storage.writeFile(path, content);
}

function createMockService(overrides: Partial<Service> = {}): Service {
  return {
    name: 'slack',
    displayName: 'Slack',
    baseApiUrls: ['https://slack.com/api/'],
    loginUrl: 'https://slack.com/signin',
    info: 'Test info for Slack service.',
    credentialCheckCurlArguments: ['https://slack.com/api/auth.test'],
    checkApiCredentials: vi.fn().mockReturnValue(ApiCredentialStatus.Valid),
    setCredentialsExample(serviceName: string) {
      return `latchkey auth set ${serviceName} -H "Authorization: Bearer xoxb-your-token"`;
    },
    getCredentialsNoCurl() {
      throw new NoCurlCredentialsNotSupportedError('slack');
    },
    getSession: vi.fn().mockReturnValue({
      login: vi.fn().mockResolvedValue(new SlackApiCredentials('xoxc-test-token', 'test-cookie')),
    }),
    ...overrides,
  };
}

function createMockConfig(overrides: Partial<Config> = {}): Config {
  const defaultConfig = new Config(() => undefined);
  const config = Object.assign(
    Object.create(Object.getPrototypeOf(defaultConfig) as object) as Config,
    defaultConfig,
    { encryptionKeyOverride: TEST_ENCRYPTION_KEY },
    overrides
  );
  return config;
}

describe('operations', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'latchkey-ops-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function createApiCredentialStore(
    credentialsData: Record<string, unknown> = {}
  ): Promise<ApiCredentialStore> {
    const storePath = join(tempDir, 'credentials.json');
    await writeSecureFile(storePath, JSON.stringify(credentialsData));
    const encryptedStorage = await EncryptedStorage.create({
      encryptionKeyOverride: TEST_ENCRYPTION_KEY,
    });
    return new ApiCredentialStore(storePath, encryptedStorage);
  }

  describe('servicesList', () => {
    it('should return sorted service names', async () => {
      const serviceA = createMockService({ name: 'zzz-service' });
      const serviceB = createMockService({ name: 'aaa-service' });
      const registry = new Registry([serviceA, serviceB]);
      const store = await createApiCredentialStore();
      const config = createMockConfig();

      const result = servicesList(registry, store, config, {});

      expect(result).toEqual(['aaa-service', 'zzz-service']);
    });

    it('should filter to builtin services only', async () => {
      const builtinService = createMockService({ name: 'slack' });
      const registeredService = new RegisteredService('my-gitlab', 'https://gitlab.example.com');
      const registry = new Registry([builtinService]);
      registry.addService(registeredService);
      const store = await createApiCredentialStore();
      const config = createMockConfig();

      const result = servicesList(registry, store, config, { builtin: true });

      expect(result).toContain('slack');
      expect(result).not.toContain('my-gitlab');
    });

    it('should filter to viable services with stored credentials', async () => {
      const service = createMockService({ name: 'slack', getSession: undefined });
      const registry = new Registry([service]);
      const store = await createApiCredentialStore({
        slack: { objectType: 'slack', token: 'test-token', dCookie: 'test-cookie' },
      });
      const config = createMockConfig({ browserDisabled: true } as Partial<Config>);

      const result = servicesList(registry, store, config, { viable: true });

      expect(result).toContain('slack');
    });

    it('should exclude non-viable services without credentials or browser', async () => {
      const service = createMockService({ name: 'nologin', getSession: undefined });
      const registry = new Registry([service]);
      const store = await createApiCredentialStore({});
      const config = createMockConfig();

      const result = servicesList(registry, store, config, { viable: true });

      expect(result).not.toContain('nologin');
    });
  });

  describe('servicesInfo', () => {
    it('should return service info', async () => {
      const service = createMockService();
      const registry = new Registry([service]);
      const store = await createApiCredentialStore();
      const config = createMockConfig();

      const info = await servicesInfo(registry, store, config, 'slack');

      expect(info.type).toBe('built-in');
      expect(info.baseApiUrls).toEqual(['https://slack.com/api/']);
      expect(info.authOptions).toContain('browser');
      expect(info.authOptions).toContain('set');
      expect(info.credentialStatus).toBe('missing');
      expect(info.developerNotes).toBe('Test info for Slack service.');
    });

    it('should throw UnknownServiceError for unknown service', async () => {
      const registry = new Registry([]);
      const store = await createApiCredentialStore();
      const config = createMockConfig();

      await expect(servicesInfo(registry, store, config, 'unknown')).rejects.toThrow(
        UnknownServiceError
      );
    });

    it('should exclude browser from authOptions when browser disabled', async () => {
      const service = createMockService();
      const registry = new Registry([service]);
      const store = await createApiCredentialStore();
      const config = createMockConfig({ browserDisabled: true } as Partial<Config>);

      const info = await servicesInfo(registry, store, config, 'slack');

      expect(info.authOptions).toEqual(['set']);
    });

    it('should show user-registered type for registered services', async () => {
      const registeredService = new RegisteredService('my-gitlab', 'https://gitlab.example.com');
      const registry = new Registry([]);
      registry.addService(registeredService);
      const store = await createApiCredentialStore();
      const config = createMockConfig();

      const info = await servicesInfo(registry, store, config, 'my-gitlab');

      expect(info.type).toBe('user-registered');
    });
  });

  describe('authList', () => {
    it('should return stored credentials with status', async () => {
      const service = createMockService();
      const registry = new Registry([service]);
      const store = await createApiCredentialStore({
        slack: { objectType: 'slack', token: 'test-token', dCookie: 'test-cookie' },
      });

      const result = await authList(registry, store);

      expect(result.slack).toEqual({
        credentialType: 'slack',
        credentialStatus: 'valid',
      });
    });

    it('should return empty object when no credentials stored', async () => {
      const registry = new Registry([]);
      const store = await createApiCredentialStore({});

      const result = await authList(registry, store);

      expect(Object.keys(result)).toHaveLength(0);
    });

    it('should treat unknown services as valid', async () => {
      const registry = new Registry([]);
      const store = await createApiCredentialStore({
        unknown: { objectType: 'rawCurl', curlArguments: ['-H', 'X-Token: secret'] },
      });

      const result = await authList(registry, store);

      expect(result.unknown).toEqual({
        credentialType: 'rawCurl',
        credentialStatus: 'valid',
      });
    });
  });

  describe('authBrowser', () => {
    it('should throw UnknownServiceError for unknown service', async () => {
      const registry = new Registry([]);
      const store = await createApiCredentialStore();
      const encryptedStorage = await EncryptedStorage.create({
        encryptionKeyOverride: TEST_ENCRYPTION_KEY,
      });
      const config = createMockConfig();

      await expect(
        authBrowser(registry, store, encryptedStorage, config, 'unknown')
      ).rejects.toThrow(UnknownServiceError);
    });

    it('should throw BrowserFlowsNotSupportedError when service has no browser support', async () => {
      const service = createMockService({ getSession: undefined });
      const registry = new Registry([service]);
      const store = await createApiCredentialStore();
      const encryptedStorage = await EncryptedStorage.create({
        encryptionKeyOverride: TEST_ENCRYPTION_KEY,
      });
      const config = createMockConfig();

      await expect(authBrowser(registry, store, encryptedStorage, config, 'slack')).rejects.toThrow(
        BrowserFlowsNotSupportedError
      );
    });

    it('should throw PreparationRequiredError when prepare is required but not done', async () => {
      const service = createMockService({
        getSession: vi.fn().mockReturnValue({
          prepare: vi.fn(),
          login: vi.fn(),
        }),
      });
      const registry = new Registry([service]);
      const store = await createApiCredentialStore({});
      const encryptedStorage = await EncryptedStorage.create({
        encryptionKeyOverride: TEST_ENCRYPTION_KEY,
      });
      const config = createMockConfig();

      await expect(authBrowser(registry, store, encryptedStorage, config, 'slack')).rejects.toThrow(
        PreparationRequiredError
      );
    });
  });

  describe('authBrowserPrepare', () => {
    it('should throw UnknownServiceError for unknown service', async () => {
      const registry = new Registry([]);
      const store = await createApiCredentialStore();
      const encryptedStorage = await EncryptedStorage.create({
        encryptionKeyOverride: TEST_ENCRYPTION_KEY,
      });
      const config = createMockConfig();

      await expect(
        authBrowserPrepare(registry, store, encryptedStorage, config, 'unknown')
      ).rejects.toThrow(UnknownServiceError);
    });

    it('should return alreadyPrepared true when service has no prepare step', async () => {
      const service = createMockService({
        getSession: vi.fn().mockReturnValue({
          login: vi.fn(),
          // No prepare method
        }),
      });
      const registry = new Registry([service]);
      const store = await createApiCredentialStore();
      const encryptedStorage = await EncryptedStorage.create({
        encryptionKeyOverride: TEST_ENCRYPTION_KEY,
      });
      const config = createMockConfig();

      const result = await authBrowserPrepare(registry, store, encryptedStorage, config, 'slack');

      expect(result.alreadyPrepared).toBe(true);
    });

    it('should return alreadyPrepared true when credentials already exist', async () => {
      const service = createMockService({
        getSession: vi.fn().mockReturnValue({
          prepare: vi.fn(),
          login: vi.fn(),
        }),
      });
      const registry = new Registry([service]);
      const store = await createApiCredentialStore({
        slack: { objectType: 'slack', token: 'test-token', dCookie: 'test-cookie' },
      });
      const encryptedStorage = await EncryptedStorage.create({
        encryptionKeyOverride: TEST_ENCRYPTION_KEY,
      });
      const config = createMockConfig();

      const result = await authBrowserPrepare(registry, store, encryptedStorage, config, 'slack');

      expect(result.alreadyPrepared).toBe(true);
    });

    it('should return alreadyPrepared true when service has no getSession', async () => {
      const service = createMockService({ getSession: undefined });
      const registry = new Registry([service]);
      const store = await createApiCredentialStore();
      const encryptedStorage = await EncryptedStorage.create({
        encryptionKeyOverride: TEST_ENCRYPTION_KEY,
      });
      const config = createMockConfig();

      const result = await authBrowserPrepare(registry, store, encryptedStorage, config, 'slack');

      expect(result.alreadyPrepared).toBe(true);
    });
  });
});
