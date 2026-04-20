import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EncryptedStorage } from '../src/encryptedStorage.js';
import { ApiCredentialStore } from '../src/apiCredentials/store.js';
import { ApiCredentialStatus } from '../src/apiCredentials/base.js';
import { NoCurlCredentialsNotSupportedError, Service } from '../src/services/core/base.js';
import { Registry } from '../src/registry.js';
import { Config } from '../src/config.js';
import type { CliDependencies } from '../src/cliCommands.js';
import type { CurlResult } from '../src/curl.js';
import { startGateway, type GatewayServer } from '../src/gateway/server.js';
import type { GatewayOptions } from '../src/gateway/gatewayEndpoint.js';
import { LatchkeyRequestSchema } from '../src/gateway/latchkeyEndpoint.js';

const TEST_ENCRYPTION_KEY = 'dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleXRlc3Q=';

async function writeSecureFile(path: string, content: string): Promise<void> {
  const storage = await EncryptedStorage.create({ encryptionKeyOverride: TEST_ENCRYPTION_KEY });
  storage.writeFile(path, content);
}

const mockSlackService: Service = {
  name: 'slack',
  displayName: 'Slack',
  baseApiUrls: ['https://slack.com/api/'],
  loginUrl: 'https://slack.com/signin',
  info: 'Test Slack service.',
  credentialCheckCurlArguments: ['https://slack.com/api/auth.test'],
  checkApiCredentials: vi.fn().mockResolvedValue(ApiCredentialStatus.Valid),
  setCredentialsExample(serviceName: string) {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer xoxb-your-token"`;
  },
  getCredentialsNoCurl() {
    throw new NoCurlCredentialsNotSupportedError('slack');
  },
};

// ─── Schema validation tests ──────────────────────────────────────────────────

describe('LatchkeyRequestSchema', () => {
  it('should validate services list with no params', () => {
    const result = LatchkeyRequestSchema.safeParse({ command: 'services list' });
    expect(result.success).toBe(true);
  });

  it('should validate services list with params', () => {
    const result = LatchkeyRequestSchema.safeParse({
      command: 'services list',
      params: { builtin: true, viable: false },
    });
    expect(result.success).toBe(true);
  });

  it('should validate services info', () => {
    const result = LatchkeyRequestSchema.safeParse({
      command: 'services info',
      params: { serviceName: 'slack' },
    });
    expect(result.success).toBe(true);
  });

  it('should reject services info without serviceName', () => {
    const result = LatchkeyRequestSchema.safeParse({
      command: 'services info',
      params: {},
    });
    expect(result.success).toBe(false);
  });

  it('should validate auth list with no params', () => {
    const result = LatchkeyRequestSchema.safeParse({ command: 'auth list' });
    expect(result.success).toBe(true);
  });

  it('should validate auth browser', () => {
    const result = LatchkeyRequestSchema.safeParse({
      command: 'auth browser',
      params: { serviceName: 'slack' },
    });
    expect(result.success).toBe(true);
  });

  it('should validate auth browser-prepare', () => {
    const result = LatchkeyRequestSchema.safeParse({
      command: 'auth browser-prepare',
      params: { serviceName: 'slack' },
    });
    expect(result.success).toBe(true);
  });

  it('should reject unknown command', () => {
    const result = LatchkeyRequestSchema.safeParse({
      command: 'unknown command',
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing command', () => {
    const result = LatchkeyRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ─── Integration tests via the gateway server ─────────────────────────────────

describe('/latchkey/ endpoint', () => {
  let tempDir: string;
  let gateway: GatewayServer | undefined;
  let logs: string[];
  let errorLogs: string[];

  function createMockConfig(configOverrides: Partial<Config> = {}): Config {
    const base = new Config((name) => {
      if (name === 'LATCHKEY_DIRECTORY') return tempDir;
      if (name === 'LATCHKEY_ENCRYPTION_KEY') return TEST_ENCRYPTION_KEY;
      return undefined;
    });
    if (Object.keys(configOverrides).length === 0) {
      return base;
    }
    return Object.assign(
      Object.create(Object.getPrototypeOf(base) as object) as Config,
      base,
      configOverrides
    );
  }

  async function createTestGateway(
    credentialsData: Record<string, unknown> = {},
    overrides: Partial<CliDependencies> = {},
    configOverrides: Partial<Config> = {}
  ): Promise<GatewayServer> {
    const storePath = join(tempDir, 'credentials.json');
    await writeSecureFile(storePath, JSON.stringify(credentialsData));

    const encryptedStorage = await EncryptedStorage.create({
      encryptionKeyOverride: TEST_ENCRYPTION_KEY,
    });
    const apiCredentialStore = new ApiCredentialStore(storePath, encryptedStorage);

    const deps: CliDependencies = {
      registry: new Registry([mockSlackService]),
      config: createMockConfig(configOverrides),
      runCurl: (): CurlResult => ({ returncode: 0, stdout: '', stderr: '' }),
      runCurlAsync: () => Promise.resolve({ returncode: 0, stdout: Buffer.from(''), stderr: '' }),
      checkPermission: () => Promise.resolve(true),
      confirm: () => Promise.resolve(true),
      exit: (code: number): never => {
        throw new Error(`process.exit(${String(code)})`);
      },
      log: (message: string) => {
        logs.push(message);
      },
      errorLog: (message: string) => {
        errorLogs.push(message);
      },
      version: '0.0.0-test',
      ...overrides,
    };

    const options: GatewayOptions = {
      port: 0,
      host: 'localhost',
      maxBodySize: 10 * 1024 * 1024,
    };

    return startGateway(deps, apiCredentialStore, encryptedStorage, options);
  }

  function getHost(): string {
    if (gateway === undefined) {
      throw new Error('Gateway not started');
    }
    const address = gateway.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Failed to get server address');
    }
    const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
    return `http://${host}:${String(address.port)}`;
  }

  function postLatchkey(body: unknown): Promise<Response> {
    return globalThis.fetch(`${getHost()}/latchkey/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'latchkey-endpoint-test-'));
    logs = [];
    errorLogs = [];
  });

  afterEach(async () => {
    if (gateway) {
      await gateway.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('method handling', () => {
    it('should reject GET with 405', async () => {
      gateway = await createTestGateway();
      const response = await globalThis.fetch(`${getHost()}/latchkey/`, { method: 'GET' });
      expect(response.status).toBe(405);
    });

    it('should reject PUT with 405', async () => {
      gateway = await createTestGateway();
      const response = await globalThis.fetch(`${getHost()}/latchkey/`, { method: 'PUT' });
      expect(response.status).toBe(405);
    });
  });

  describe('validation', () => {
    it('should return 400 for invalid JSON', async () => {
      gateway = await createTestGateway();
      const response = await globalThis.fetch(`${getHost()}/latchkey/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('Invalid JSON');
    });

    it('should return 400 for unknown command', async () => {
      gateway = await createTestGateway();
      const response = await postLatchkey({ command: 'unknown' });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("unknown command 'unknown'");
    });

    it('should return 400 for missing command', async () => {
      gateway = await createTestGateway();
      const response = await postLatchkey({});
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("missing required field 'command'");
    });

    it('should return 400 for missing required serviceName', async () => {
      gateway = await createTestGateway();
      const response = await postLatchkey({
        command: 'services info',
        params: {},
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("missing required argument 'service_name'");
    });

    it('should return 400 for missing params', async () => {
      gateway = await createTestGateway();
      const response = await postLatchkey({ command: 'services info' });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("missing required argument 'service_name'");
    });
  });

  describe('services list', () => {
    it('should return list of service names', async () => {
      gateway = await createTestGateway();
      const response = await postLatchkey({ command: 'services list' });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { result: string[] };
      expect(body.result).toContain('slack');
    });

    it('should support builtin filter', async () => {
      gateway = await createTestGateway();
      const response = await postLatchkey({
        command: 'services list',
        params: { builtin: true },
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { result: string[] };
      expect(body.result).toContain('slack');
    });
  });

  describe('services info', () => {
    it('should return service info', async () => {
      gateway = await createTestGateway();
      const response = await postLatchkey({
        command: 'services info',
        params: { serviceName: 'slack' },
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        result: { type: string; credentialStatus: string };
      };
      expect(body.result.type).toBe('built-in');
      expect(body.result.credentialStatus).toBe('missing');
    });

    it('should return error for unknown service', async () => {
      gateway = await createTestGateway();
      const response = await postLatchkey({
        command: 'services info',
        params: { serviceName: 'unknown-service' },
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('Unknown service');
    });
  });

  describe('auth list', () => {
    it('should return empty object when no credentials stored', async () => {
      gateway = await createTestGateway();
      const response = await postLatchkey({ command: 'auth list' });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { result: Record<string, unknown> };
      expect(Object.keys(body.result)).toHaveLength(0);
    });

    it('should return stored credentials with status', async () => {
      gateway = await createTestGateway({
        slack: { objectType: 'slack', token: 'test-token', dCookie: 'test-cookie' },
      });
      const response = await postLatchkey({ command: 'auth list' });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        result: Record<string, { credentialType: string; credentialStatus: string }>;
      };
      expect(body.result.slack).toEqual({
        credentialType: 'slack',
        credentialStatus: 'valid',
      });
    });
  });

  describe('auth browser', () => {
    it('should return error for unknown service', async () => {
      gateway = await createTestGateway();
      const response = await postLatchkey({
        command: 'auth browser',
        params: { serviceName: 'unknown-service' },
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('Unknown service');
    });

    it('should return error when browser is disabled', async () => {
      const browserSlack: Service = Object.assign({}, mockSlackService, {
        getSession: vi.fn().mockReturnValue({
          login: vi.fn(),
        }),
      });
      gateway = await createTestGateway(
        {},
        { registry: new Registry([browserSlack]) },
        { browserDisabled: true }
      );
      const response = await postLatchkey({
        command: 'auth browser',
        params: { serviceName: 'slack' },
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('disabled');
    });

    it('should return error for service without browser support', async () => {
      const noLoginService: Service = {
        name: 'nologin',
        displayName: 'No Login Service',
        baseApiUrls: ['https://nologin.example.com/api/'],
        loginUrl: 'https://nologin.example.com',
        info: 'No browser login support.',
        credentialCheckCurlArguments: [],
        checkApiCredentials: vi.fn().mockResolvedValue(ApiCredentialStatus.Missing),
        setCredentialsExample(serviceName: string) {
          return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
        },
        getCredentialsNoCurl() {
          throw new NoCurlCredentialsNotSupportedError('nologin');
        },
      };

      gateway = await createTestGateway({}, { registry: new Registry([noLoginService]) });
      const response = await postLatchkey({
        command: 'auth browser',
        params: { serviceName: 'nologin' },
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('does not support browser flows');
    });
  });

  describe('auth browser-prepare', () => {
    it('should return error for unknown service', async () => {
      gateway = await createTestGateway();
      const response = await postLatchkey({
        command: 'auth browser-prepare',
        params: { serviceName: 'unknown-service' },
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('Unknown service');
    });

    it('should return alreadyPrepared when service has no prepare step', async () => {
      gateway = await createTestGateway();
      const response = await postLatchkey({
        command: 'auth browser-prepare',
        params: { serviceName: 'slack' },
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        result: { alreadyPrepared: boolean };
      };
      // mockSlackService has getSession but no prepare, so alreadyPrepared = true
      expect(body.result.alreadyPrepared).toBe(true);
    });
  });

  describe('logging', () => {
    it('should log requests', async () => {
      gateway = await createTestGateway();
      await postLatchkey({ command: 'services list' });

      expect(logs.some((l) => l.includes('POST /latchkey/') && l.includes('services list'))).toBe(
        true
      );
    });
  });

  describe('path variants', () => {
    it('should handle /latchkey without trailing slash', async () => {
      gateway = await createTestGateway();
      const response = await globalThis.fetch(`${getHost()}/latchkey`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'services list' }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { result: string[] };
      expect(body.result).toBeDefined();
    });
  });
});
