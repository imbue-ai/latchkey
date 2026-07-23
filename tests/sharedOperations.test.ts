import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EncryptedStorage } from '../src/encryptedStorage.js';
import { ApiCredentialStore } from '../src/apiCredentials/store.js';
import { OAuthCredentials } from '../src/apiCredentials/base.js';
import { SlackApiCredentials } from '../src/services/slack.js';
import {
  PrepareInputInvalidError,
  PrepareNotSupportedError,
  Service,
} from '../src/services/core/base.js';
import { MockService } from './mockService.js';
import { GOOGLE_GMAIL } from '../src/services/google/gmail.js';
import { NOTION_MCP } from '../src/services/notion-mcp.js';
import { RegisteredService } from '../src/services/core/registered.js';
import { ServiceRegistry } from '../src/serviceRegistry.js';
import { saveBrowserConfig } from '../src/configDataStore.js';
import { Config } from '../src/config.js';
import {
  servicesList,
  servicesInfo,
  authList,
  authBrowser,
  authBrowserPrepare,
  prepareService,
  UnknownServiceError,
  AccountNotFoundError,
  PreparationRequiredError,
} from '../src/sharedOperations.js';
import { BrowserFlowsNotSupportedError } from '../src/playwrightUtils.js';

const TEST_ENCRYPTION_KEY = 'dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleXRlc3Q=';

function writeSecureFile(path: string, content: string): void {
  const storage = new EncryptedStorage(TEST_ENCRYPTION_KEY);
  storage.writeFile(path, content);
}

function createMockService(overrides: Partial<MockService> = {}): Service {
  return Object.assign(new MockService(), overrides);
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

  function createApiCredentialStore(
    credentialsData: Record<string, unknown> = {}
  ): ApiCredentialStore {
    const storePath = join(tempDir, 'credentials.json');
    // Store credentials under the default account, matching the on-disk layout.
    const nestedCredentials = Object.fromEntries(
      Object.entries(credentialsData).map(([service, creds]) => [service, { '': creds }])
    );
    writeSecureFile(storePath, JSON.stringify({ credentials: nestedCredentials }));
    const encryptedStorage = new EncryptedStorage(TEST_ENCRYPTION_KEY);
    return new ApiCredentialStore(storePath, encryptedStorage);
  }

  describe('servicesList', () => {
    it('should return sorted service names', () => {
      const serviceA = createMockService({ name: 'zzz-service' });
      const serviceB = createMockService({ name: 'aaa-service' });
      const registry = new ServiceRegistry([serviceA, serviceB]);
      const store = createApiCredentialStore();
      const config = createMockConfig();

      const result = servicesList(registry, store, config, {});

      expect(result).toEqual(['aaa-service', 'zzz-service']);
    });

    it('should filter to builtin services only', () => {
      const builtinService = createMockService({ name: 'slack' });
      const registeredService = new RegisteredService('my-gitlab', 'https://gitlab.example.com');
      const registry = new ServiceRegistry([builtinService]);
      registry.addService(registeredService);
      const store = createApiCredentialStore();
      const config = createMockConfig();

      const result = servicesList(registry, store, config, { builtin: true });

      expect(result).toContain('slack');
      expect(result).not.toContain('my-gitlab');
    });

    it('should filter to viable services with stored credentials', () => {
      const service = createMockService({ name: 'slack', getSession: undefined });
      const registry = new ServiceRegistry([service]);
      const store = createApiCredentialStore({
        slack: { objectType: 'slack', token: 'test-token', dCookie: 'test-cookie' },
      });
      const config = createMockConfig({ browserDisabled: true } as Partial<Config>);

      const result = servicesList(registry, store, config, { viable: true });

      expect(result).toContain('slack');
    });

    it('should exclude non-viable services without credentials or browser', () => {
      const service = createMockService({ name: 'nologin', getSession: undefined });
      const registry = new ServiceRegistry([service]);
      const store = createApiCredentialStore({});
      const config = createMockConfig();

      const result = servicesList(registry, store, config, { viable: true });

      expect(result).not.toContain('nologin');
    });
  });

  describe('servicesInfo', () => {
    it('should return service info', async () => {
      const service = createMockService();
      const registry = new ServiceRegistry([service]);
      const store = createApiCredentialStore();
      const config = createMockConfig();

      const info = await servicesInfo(registry, store, config, 'slack');

      expect(info.type).toBe('built-in');
      expect(info.baseApiUrls).toEqual(['https://slack.com/api/']);
      expect(info.authOptions).toContain('browser');
      expect(info.authOptions).toContain('set');
      expect(info.credentials).toEqual({});
      expect(info.developerNotes).toBe('Test info for Slack service.');
    });

    it('should throw UnknownServiceError for unknown service', async () => {
      const registry = new ServiceRegistry([]);
      const store = createApiCredentialStore();
      const config = createMockConfig();

      await expect(servicesInfo(registry, store, config, 'unknown')).rejects.toThrow(
        UnknownServiceError
      );
    });

    it('should exclude browser from authOptions when browser disabled', async () => {
      const service = createMockService();
      const registry = new ServiceRegistry([service]);
      const store = createApiCredentialStore();
      const config = createMockConfig({ browserDisabled: true } as Partial<Config>);

      const info = await servicesInfo(registry, store, config, 'slack');

      expect(info.authOptions).toEqual(['set']);
    });

    it('should show user-registered type for registered services', async () => {
      const registeredService = new RegisteredService('my-gitlab', 'https://gitlab.example.com');
      const registry = new ServiceRegistry([]);
      registry.addService(registeredService);
      const store = createApiCredentialStore();
      const config = createMockConfig();

      const info = await servicesInfo(registry, store, config, 'my-gitlab');

      expect(info.type).toBe('user-registered');
    });

    it('should return stored credentials keyed by account', async () => {
      const service = createMockService();
      const registry = new ServiceRegistry([service]);
      const store = createApiCredentialStore();
      store.save('slack', new SlackApiCredentials('default-token', 'default-cookie'));
      store.save('slack', new SlackApiCredentials('work-token', 'work-cookie'), 'work@example.com');
      const config = createMockConfig();

      const info = await servicesInfo(registry, store, config, 'slack');

      expect(info.credentials).toEqual({
        '': { credentialType: 'slack', credentialStatus: 'valid' },
        'work@example.com': { credentialType: 'slack', credentialStatus: 'valid' },
      });
    });
  });

  describe('authList', () => {
    it('should return stored credentials with status', async () => {
      const service = createMockService();
      const registry = new ServiceRegistry([service]);
      const store = createApiCredentialStore({
        slack: { objectType: 'slack', token: 'test-token', dCookie: 'test-cookie' },
      });

      const result = await authList(registry, store, createMockConfig());

      expect(result.slack).toEqual({
        '': {
          credentialType: 'slack',
          credentialStatus: 'valid',
        },
      });
    });

    it('should return empty object when no credentials stored', async () => {
      const registry = new ServiceRegistry([]);
      const store = createApiCredentialStore({});

      const result = await authList(registry, store, createMockConfig());

      expect(Object.keys(result)).toHaveLength(0);
    });

    it('should omit stored credentials for services not in the registry', async () => {
      const service = createMockService();
      const registry = new ServiceRegistry([service]);
      const store = createApiCredentialStore({
        slack: { objectType: 'slack', token: 'test-token', dCookie: 'test-cookie' },
        unknown: { objectType: 'rawCurl', curlArguments: ['-H', 'X-Token: secret'] },
      });

      const result = await authList(registry, store, createMockConfig());

      expect(Object.keys(result)).toEqual(['slack']);
      expect(result.unknown).toBeUndefined();
    });
  });

  describe('authBrowser', () => {
    it('should throw UnknownServiceError for unknown service', async () => {
      const registry = new ServiceRegistry([]);
      const store = createApiCredentialStore();
      const encryptedStorage = new EncryptedStorage(TEST_ENCRYPTION_KEY);
      const config = createMockConfig();

      await expect(
        authBrowser(registry, store, encryptedStorage, config, 'unknown')
      ).rejects.toThrow(UnknownServiceError);
    });

    it('should throw BrowserFlowsNotSupportedError when service has no browser support', async () => {
      const service = createMockService({ getSession: undefined });
      const registry = new ServiceRegistry([service]);
      const store = createApiCredentialStore();
      const encryptedStorage = new EncryptedStorage(TEST_ENCRYPTION_KEY);
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
      const registry = new ServiceRegistry([service]);
      const store = createApiCredentialStore({});
      const encryptedStorage = new EncryptedStorage(TEST_ENCRYPTION_KEY);
      const config = createMockConfig();

      await expect(authBrowser(registry, store, encryptedStorage, config, 'slack')).rejects.toThrow(
        PreparationRequiredError
      );
    });

    it('stores credentials under the account reported by the login flow', async () => {
      const originalPlatform = process.platform;
      // Pretend we are on macOS so the graphical-environment check passes
      // without relying on DISPLAY being set.
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        const login = vi.fn().mockResolvedValue({
          credentials: new SlackApiCredentials('xoxc-token', 'cookie'),
          account: 'user@example.com',
        });
        const service = createMockService({ getSession: vi.fn().mockReturnValue({ login }) });
        const registry = new ServiceRegistry([service]);
        const store = createApiCredentialStore();
        const encryptedStorage = new EncryptedStorage(TEST_ENCRYPTION_KEY);
        const config = createMockConfig({ directory: tempDir } as Partial<Config>);
        // A valid browser config is required for the login flow to start; point
        // it at any existing file.
        saveBrowserConfig(config.configPath, {
          executablePath: process.execPath,
          source: 'system',
          discoveredAt: new Date().toISOString(),
        });

        const result = await authBrowser(registry, store, encryptedStorage, config, 'slack');

        expect(result).toEqual({ account: 'user@example.com' });
        expect(store.listAccounts('slack')).toEqual(['user@example.com']);
        expect(store.get('slack', 'user@example.com')).toBeInstanceOf(SlackApiCredentials);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });

    it('omits the browser state path when ephemeral browser mode is enabled', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        const login = vi.fn().mockResolvedValue({
          credentials: new SlackApiCredentials('xoxc-token', 'cookie'),
          account: 'user@example.com',
        });
        const service = createMockService({ getSession: vi.fn().mockReturnValue({ login }) });
        const registry = new ServiceRegistry([service]);
        const store = createApiCredentialStore();
        const encryptedStorage = new EncryptedStorage(TEST_ENCRYPTION_KEY);
        const config = createMockConfig({
          directory: tempDir,
          browserEphemeral: true,
        } as Partial<Config>);
        saveBrowserConfig(config.configPath, {
          executablePath: process.execPath,
          source: 'system',
          discoveredAt: new Date().toISOString(),
        });

        await authBrowser(registry, store, encryptedStorage, config, 'slack');

        const launchOptions = login.mock.calls[0]?.[1] as { browserStatePath?: string };
        expect(launchOptions.browserStatePath).toBeUndefined();
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });

    it('passes the browser state path when ephemeral browser mode is disabled', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        const login = vi.fn().mockResolvedValue({
          credentials: new SlackApiCredentials('xoxc-token', 'cookie'),
          account: 'user@example.com',
        });
        const service = createMockService({ getSession: vi.fn().mockReturnValue({ login }) });
        const registry = new ServiceRegistry([service]);
        const store = createApiCredentialStore();
        const encryptedStorage = new EncryptedStorage(TEST_ENCRYPTION_KEY);
        const config = createMockConfig({ directory: tempDir } as Partial<Config>);
        saveBrowserConfig(config.configPath, {
          executablePath: process.execPath,
          source: 'system',
          discoveredAt: new Date().toISOString(),
        });

        await authBrowser(registry, store, encryptedStorage, config, 'slack');

        const launchOptions = login.mock.calls[0]?.[1] as { browserStatePath?: string };
        expect(launchOptions.browserStatePath).toBe(config.browserStatePath);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });

    it('logs in to an additional account without ambiguity', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        const login = vi.fn().mockResolvedValue({
          credentials: new SlackApiCredentials('second-token', 'second-cookie'),
          account: 'second@example.com',
        });
        const service = createMockService({ getSession: vi.fn().mockReturnValue({ login }) });
        const registry = new ServiceRegistry([service]);
        const store = createApiCredentialStore();
        store.save(
          'slack',
          new SlackApiCredentials('first-token', 'first-cookie'),
          'first@example.com'
        );
        const encryptedStorage = new EncryptedStorage(TEST_ENCRYPTION_KEY);
        const config = createMockConfig({ directory: tempDir } as Partial<Config>);
        saveBrowserConfig(config.configPath, {
          executablePath: process.execPath,
          source: 'system',
          discoveredAt: new Date().toISOString(),
        });

        const result = await authBrowser(registry, store, encryptedStorage, config, 'slack');

        expect(result).toEqual({ account: 'second@example.com' });
        expect(store.listAccounts('slack')).toEqual(['first@example.com', 'second@example.com']);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });

    it('uses the stored preparation for login and keeps it for future logins', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        const preparedClient = new OAuthCredentials('client-id', 'client-secret');
        const fullCredentials = new OAuthCredentials(
          'client-id',
          'client-secret',
          'access-token',
          'refresh-token'
        );
        const login = vi.fn().mockResolvedValue({
          credentials: fullCredentials,
          account: 'user@example.com',
        });
        const service = createMockService({
          getSession: vi.fn().mockReturnValue({ prepare: vi.fn(), login }),
        });
        const registry = new ServiceRegistry([service]);
        const store = createApiCredentialStore();
        store.savePreparation('slack', preparedClient);
        const encryptedStorage = new EncryptedStorage(TEST_ENCRYPTION_KEY);
        const config = createMockConfig({ directory: tempDir } as Partial<Config>);
        saveBrowserConfig(config.configPath, {
          executablePath: process.execPath,
          source: 'system',
          discoveredAt: new Date().toISOString(),
        });

        const result = await authBrowser(registry, store, encryptedStorage, config, 'slack');

        expect(result).toEqual({ account: 'user@example.com' });
        expect(store.listAccounts('slack')).toEqual(['user@example.com']);
        const reusedCredentials = login.mock.calls[0]?.[2] as OAuthCredentials;
        expect(reusedCredentials.clientId).toBe('client-id');
        // The preparation stays around so another account can log in with the
        // same client.
        expect(store.getPreparation('slack')).toBeInstanceOf(OAuthCredentials);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });

    it("reuses the named account's credentials when an account is given", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        const existingCredentials = new OAuthCredentials(
          'client-id',
          'client-secret',
          'old-access-token',
          'old-refresh-token'
        );
        const login = vi.fn().mockResolvedValue({
          credentials: new OAuthCredentials(
            'client-id',
            'client-secret',
            'new-access-token',
            'new-refresh-token'
          ),
          account: 'second@example.com',
        });
        const service = createMockService({
          getSession: vi.fn().mockReturnValue({ prepare: vi.fn(), login }),
        });
        const registry = new ServiceRegistry([service]);
        const store = createApiCredentialStore();
        store.save('slack', existingCredentials, 'first@example.com');
        const encryptedStorage = new EncryptedStorage(TEST_ENCRYPTION_KEY);
        const config = createMockConfig({ directory: tempDir } as Partial<Config>);
        saveBrowserConfig(config.configPath, {
          executablePath: process.execPath,
          source: 'system',
          discoveredAt: new Date().toISOString(),
        });

        const result = await authBrowser(
          registry,
          store,
          encryptedStorage,
          config,
          'slack',
          'first@example.com'
        );

        expect(result).toEqual({ account: 'second@example.com' });
        expect(store.listAccounts('slack')).toEqual(['first@example.com', 'second@example.com']);
        const reusedCredentials = login.mock.calls[0]?.[2] as OAuthCredentials;
        expect(reusedCredentials.accessToken).toBe('old-access-token');
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });

    it('throws AccountNotFoundError when the given account has no credentials', async () => {
      const service = createMockService({
        getSession: vi.fn().mockReturnValue({ login: vi.fn() }),
      });
      const registry = new ServiceRegistry([service]);
      const store = createApiCredentialStore();
      const encryptedStorage = new EncryptedStorage(TEST_ENCRYPTION_KEY);
      const config = createMockConfig();

      await expect(
        authBrowser(registry, store, encryptedStorage, config, 'slack', 'missing@example.com')
      ).rejects.toThrow(AccountNotFoundError);
    });

    it('keeps complete default-account credentials when a login adds a named account', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        const login = vi.fn().mockResolvedValue({
          credentials: new SlackApiCredentials('named-token', 'named-cookie'),
          account: 'user@example.com',
        });
        const service = createMockService({ getSession: vi.fn().mockReturnValue({ login }) });
        const registry = new ServiceRegistry([service]);
        const store = createApiCredentialStore();
        store.save('slack', new SlackApiCredentials('default-token', 'default-cookie'), '');
        const encryptedStorage = new EncryptedStorage(TEST_ENCRYPTION_KEY);
        const config = createMockConfig({ directory: tempDir } as Partial<Config>);
        saveBrowserConfig(config.configPath, {
          executablePath: process.execPath,
          source: 'system',
          discoveredAt: new Date().toISOString(),
        });

        await authBrowser(registry, store, encryptedStorage, config, 'slack');

        expect(store.listAccounts('slack')).toEqual(['', 'user@example.com']);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });
  });

  describe('authBrowserPrepare', () => {
    it('should throw UnknownServiceError for unknown service', async () => {
      const registry = new ServiceRegistry([]);
      const store = createApiCredentialStore();
      const encryptedStorage = new EncryptedStorage(TEST_ENCRYPTION_KEY);
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
      const registry = new ServiceRegistry([service]);
      const store = createApiCredentialStore();
      const encryptedStorage = new EncryptedStorage(TEST_ENCRYPTION_KEY);
      const config = createMockConfig();

      const result = await authBrowserPrepare(registry, store, encryptedStorage, config, 'slack');

      expect(result.alreadyPrepared).toBe(true);
    });

    it('re-runs the prepare flow when a preparation already exists', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        const prepare = vi
          .fn()
          .mockResolvedValue(new OAuthCredentials('new-client-id', 'new-client-secret'));
        const service = createMockService({
          getSession: vi.fn().mockReturnValue({
            prepare,
            login: vi.fn(),
          }),
        });
        const registry = new ServiceRegistry([service]);
        const store = createApiCredentialStore();
        store.savePreparation('slack', new OAuthCredentials('client-id', 'client-secret'));
        const encryptedStorage = new EncryptedStorage(TEST_ENCRYPTION_KEY);
        const config = createMockConfig({ directory: tempDir } as Partial<Config>);
        saveBrowserConfig(config.configPath, {
          executablePath: process.execPath,
          source: 'system',
          discoveredAt: new Date().toISOString(),
        });

        const result = await authBrowserPrepare(registry, store, encryptedStorage, config, 'slack');

        expect(result).toEqual({ alreadyPrepared: false });
        expect(prepare).toHaveBeenCalledOnce();
        // The new preparation overwrites the previous one.
        const preparation = store.getPreparation('slack') as OAuthCredentials;
        expect(preparation.clientId).toBe('new-client-id');
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });

    it('should return alreadyPrepared true when service has no getSession', async () => {
      const service = createMockService({ getSession: undefined });
      const registry = new ServiceRegistry([service]);
      const store = createApiCredentialStore();
      const encryptedStorage = new EncryptedStorage(TEST_ENCRYPTION_KEY);
      const config = createMockConfig();

      const result = await authBrowserPrepare(registry, store, encryptedStorage, config, 'slack');

      expect(result.alreadyPrepared).toBe(true);
    });

    it("stores the prepared credentials as the service's preparation", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        const prepare = vi
          .fn()
          .mockResolvedValue(new OAuthCredentials('client-id', 'client-secret'));
        const service = createMockService({
          getSession: vi.fn().mockReturnValue({ prepare, login: vi.fn() }),
        });
        const registry = new ServiceRegistry([service]);
        const store = createApiCredentialStore();
        const encryptedStorage = new EncryptedStorage(TEST_ENCRYPTION_KEY);
        const config = createMockConfig({ directory: tempDir } as Partial<Config>);
        saveBrowserConfig(config.configPath, {
          executablePath: process.execPath,
          source: 'system',
          discoveredAt: new Date().toISOString(),
        });

        const result = await authBrowserPrepare(registry, store, encryptedStorage, config, 'slack');

        expect(result).toEqual({ alreadyPrepared: false });
        expect(store.getPreparation('slack')).toBeInstanceOf(OAuthCredentials);
        // Preparations are not account credentials.
        expect(store.listAccounts('slack')).toEqual([]);
        expect(prepare).toHaveBeenCalledOnce();
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });
  });

  describe('prepareService', () => {
    it('stores a token-less OAuth preparation for a Google service and returns the result', () => {
      const registry = new ServiceRegistry([GOOGLE_GMAIL]);
      const store = createApiCredentialStore();

      const result = prepareService(
        registry,
        store,
        'google-gmail',
        JSON.stringify({ clientId: 'cid', clientSecret: 'csecret' })
      );

      expect(result).toEqual({ serviceName: 'google-gmail', credentialType: 'oauth' });
      const stored = store.getPreparation('google-gmail');
      expect(stored).toBeInstanceOf(OAuthCredentials);
      const oauth = stored as OAuthCredentials;
      expect(oauth.clientId).toBe('cid');
      expect(oauth.clientSecret).toBe('csecret');
      expect(oauth.accessToken).toBeUndefined();
      expect(oauth.refreshToken).toBeUndefined();
      // Preparations do not touch the credentials section.
      expect(store.get('google-gmail')).toBeNull();
    });

    it('overwrites an existing preparation unconditionally', () => {
      const registry = new ServiceRegistry([GOOGLE_GMAIL]);
      const store = createApiCredentialStore();
      store.savePreparation('google-gmail', new OAuthCredentials('old-id', 'old-secret'));

      prepareService(
        registry,
        store,
        'google-gmail',
        JSON.stringify({ clientId: 'new-id', clientSecret: 'new-secret' })
      );

      expect((store.getPreparation('google-gmail') as OAuthCredentials).clientId).toBe('new-id');
      expect((store.getPreparation('google-gmail') as OAuthCredentials).clientSecret).toBe(
        'new-secret'
      );
    });

    it('throws UnknownServiceError for an unknown service', () => {
      const registry = new ServiceRegistry([GOOGLE_GMAIL]);
      const store = createApiCredentialStore();

      expect(() => prepareService(registry, store, 'nope', '{}')).toThrow(UnknownServiceError);
    });

    it('throws PrepareNotSupportedError for a service without a prepare schema, storing nothing', () => {
      const registry = new ServiceRegistry([createMockService({ name: 'slack' })]);
      const store = createApiCredentialStore();

      expect(() =>
        prepareService(
          registry,
          store,
          'slack',
          JSON.stringify({ clientId: 'a', clientSecret: 'b' })
        )
      ).toThrow(PrepareNotSupportedError);
      expect(store.getPreparation('slack')).toBeNull();
    });

    it('rejects malformed JSON without storing anything', () => {
      const registry = new ServiceRegistry([GOOGLE_GMAIL]);
      const store = createApiCredentialStore();

      expect(() => prepareService(registry, store, 'google-gmail', '{not valid')).toThrow(
        PrepareInputInvalidError
      );
      expect(store.getPreparation('google-gmail')).toBeNull();
    });

    it('rejects input missing required fields without storing anything', () => {
      const registry = new ServiceRegistry([GOOGLE_GMAIL]);
      const store = createApiCredentialStore();

      expect(() =>
        prepareService(registry, store, 'google-gmail', JSON.stringify({ clientId: 'only-id' }))
      ).toThrow(PrepareInputInvalidError);
      expect(store.getPreparation('google-gmail')).toBeNull();
    });

    it('rejects unknown keys (strict schema)', () => {
      const registry = new ServiceRegistry([GOOGLE_GMAIL]);
      const store = createApiCredentialStore();

      expect(() =>
        prepareService(
          registry,
          store,
          'google-gmail',
          JSON.stringify({ clientId: 'a', clientSecret: 'b', extra: 'nope' })
        )
      ).toThrow(PrepareInputInvalidError);
      expect(store.getPreparation('google-gmail')).toBeNull();
    });

    it('rejects empty string fields', () => {
      const registry = new ServiceRegistry([GOOGLE_GMAIL]);
      const store = createApiCredentialStore();

      expect(() =>
        prepareService(
          registry,
          store,
          'google-gmail',
          JSON.stringify({ clientId: '', clientSecret: 'b' })
        )
      ).toThrow(PrepareInputInvalidError);
    });

    it('stores a token-less OAuth client id for notion-mcp (public client, no secret)', () => {
      const registry = new ServiceRegistry([NOTION_MCP]);
      const store = createApiCredentialStore();

      const result = prepareService(
        registry,
        store,
        'notion-mcp',
        JSON.stringify({ clientId: 'notion-client-id' })
      );

      expect(result).toEqual({ serviceName: 'notion-mcp', credentialType: 'oauth' });
      const stored = store.getPreparation('notion-mcp');
      expect(stored).toBeInstanceOf(OAuthCredentials);
      const oauth = stored as OAuthCredentials;
      expect(oauth.clientId).toBe('notion-client-id');
      expect(oauth.clientSecret).toBe('');
      expect(oauth.accessToken).toBeUndefined();
      expect(oauth.refreshToken).toBeUndefined();
    });

    it('rejects a notion-mcp clientSecret (unknown key, strict schema)', () => {
      const registry = new ServiceRegistry([NOTION_MCP]);
      const store = createApiCredentialStore();

      expect(() =>
        prepareService(
          registry,
          store,
          'notion-mcp',
          JSON.stringify({ clientId: 'a', clientSecret: 'b' })
        )
      ).toThrow(PrepareInputInvalidError);
      expect(store.getPreparation('notion-mcp')).toBeNull();
    });

    it('rejects notion-mcp input missing clientId', () => {
      const registry = new ServiceRegistry([NOTION_MCP]);
      const store = createApiCredentialStore();

      expect(() => prepareService(registry, store, 'notion-mcp', '{}')).toThrow(
        PrepareInputInvalidError
      );
      expect(store.getPreparation('notion-mcp')).toBeNull();
    });
  });
});
