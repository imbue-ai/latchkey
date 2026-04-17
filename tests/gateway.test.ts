import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import { registerCommands, type CliDependencies } from '../src/cliCommands.js';
import {
  extractTargetUrl,
  buildCurlArguments,
  parseResponseHeaders,
  type GatewayOptions,
} from '../src/gateway/gatewayEndpoint.js';
import { startGateway, type GatewayServer } from '../src/gateway/server.js';
import type { AsyncCurlResult, CurlResult } from '../src/curl.js';
import { EncryptedStorage } from '../src/encryptedStorage.js';
import { ApiCredentialStore } from '../src/apiCredentials/store.js';
import { Config } from '../src/config.js';
import { Registry } from '../src/registry.js';
import { ApiCredentialStatus } from '../src/apiCredentials/base.js';
import { NoCurlCredentialsNotSupportedError, Service } from '../src/services/core/base.js';

const TEST_ENCRYPTION_KEY = 'dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleXRlc3Q=';

async function writeSecureFile(path: string, content: string): Promise<void> {
  const storage = await EncryptedStorage.create({ encryptionKeyOverride: TEST_ENCRYPTION_KEY });
  storage.writeFile(path, content);
}

// ─── Unit Tests ───────────────────────────────────────────────────────────────

describe('extractTargetUrl', () => {
  it('should extract https URL from gateway path', () => {
    expect(extractTargetUrl('/gateway/https://api.github.com/user')).toBe(
      'https://api.github.com/user'
    );
  });

  it('should extract http URL from gateway path', () => {
    expect(extractTargetUrl('/gateway/http://localhost:3000/api')).toBe(
      'http://localhost:3000/api'
    );
  });

  it('should preserve query parameters', () => {
    expect(
      extractTargetUrl('/gateway/https://api.github.com/search/repositories?q=auth&sort=stars')
    ).toBe('https://api.github.com/search/repositories?q=auth&sort=stars');
  });

  it('should return null for non-gateway paths', () => {
    expect(extractTargetUrl('/other/https://example.com')).toBeNull();
    expect(extractTargetUrl('/')).toBeNull();
    expect(extractTargetUrl('')).toBeNull();
  });

  it('should return null for non-HTTP schemes', () => {
    expect(extractTargetUrl('/gateway/ftp://example.com')).toBeNull();
    expect(extractTargetUrl('/gateway/not-a-url')).toBeNull();
  });

  it('should return null for empty target after prefix', () => {
    expect(extractTargetUrl('/gateway/')).toBeNull();
  });
});

describe('buildCurlArguments', () => {
  it('should build GET request with URL only', () => {
    const args = buildCurlArguments('GET', new Map(), 'https://api.example.com/test', false);
    expect(args).toEqual(['https://api.example.com/test']);
  });

  it('should add -X for non-GET methods', () => {
    const args = buildCurlArguments('POST', new Map(), 'https://api.example.com/test', false);
    expect(args).toEqual(['-X', 'POST', 'https://api.example.com/test']);
  });

  it('should forward headers', () => {
    const headers = new Map([
      ['Content-Type', 'application/json'],
      ['Accept', 'application/json'],
    ]);
    const args = buildCurlArguments('GET', headers, 'https://api.example.com/test', false);
    expect(args).toContain('-H');
    expect(args).toContain('Content-Type: application/json');
    expect(args).toContain('Accept: application/json');
  });

  it('should strip hop-by-hop headers', () => {
    const headers = new Map([
      ['Content-Type', 'application/json'],
      ['Connection', 'keep-alive'],
      ['Host', 'api.example.com'],
      ['Transfer-Encoding', 'chunked'],
      ['Keep-Alive', 'timeout=5'],
    ]);
    const args = buildCurlArguments('GET', headers, 'https://api.example.com/test', false);
    expect(args).toContain('Content-Type: application/json');
    expect(args.join(' ')).not.toContain('Connection');
    expect(args.join(' ')).not.toContain('Host');
    expect(args.join(' ')).not.toContain('Transfer-Encoding');
    expect(args.join(' ')).not.toContain('Keep-Alive');
  });

  it('should add --data-binary @- when body is present', () => {
    const args = buildCurlArguments(
      'POST',
      new Map([['Content-Type', 'application/json']]),
      'https://api.example.com/test',
      true
    );
    expect(args).toContain('--data-binary');
    expect(args).toContain('@-');
  });

  it('should not add --data-binary when no body', () => {
    const args = buildCurlArguments('POST', new Map(), 'https://api.example.com/test', false);
    expect(args).not.toContain('--data-binary');
  });
});

describe('parseResponseHeaders', () => {
  it('should parse status line and headers', () => {
    const dump = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Custom: value\r\n\r\n';
    const result = parseResponseHeaders(dump);
    expect(result.statusCode).toBe(200);
    expect(result.headers.get('content-type')).toEqual(['application/json']);
    expect(result.headers.get('x-custom')).toEqual(['value']);
  });

  it('should parse HTTP/2 status line', () => {
    const dump = 'HTTP/2 404\r\nContent-Type: text/plain\r\n\r\n';
    const result = parseResponseHeaders(dump);
    expect(result.statusCode).toBe(404);
  });

  it('should handle multiple values for the same header', () => {
    const dump = 'HTTP/1.1 200 OK\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n';
    const result = parseResponseHeaders(dump);
    expect(result.headers.get('set-cookie')).toEqual(['a=1', 'b=2']);
  });

  it('should use last status line in case of redirects or 100 Continue', () => {
    const dump = 'HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n';
    const result = parseResponseHeaders(dump);
    expect(result.statusCode).toBe(200);
    expect(result.headers.get('content-type')).toEqual(['text/html']);
  });

  it('should handle empty header dump', () => {
    const result = parseResponseHeaders('');
    expect(result.statusCode).toBe(0);
    expect(result.headers.size).toBe(0);
  });

  it('should handle LF-only line endings', () => {
    const dump = 'HTTP/1.1 200 OK\nContent-Type: text/plain\n\n';
    const result = parseResponseHeaders(dump);
    expect(result.statusCode).toBe(200);
    expect(result.headers.get('content-type')).toEqual(['text/plain']);
  });
});

// ─── Integration Tests ────────────────────────────────────────────────────────

describe('gateway server', () => {
  let tempDir: string;
  let gateway: GatewayServer | undefined;
  let logs: string[];
  let errorLogs: string[];
  let capturedCurlArgs: readonly string[];
  let capturedCurlStdin: Buffer | undefined;
  let mockCurlResponse: AsyncCurlResult;
  let mockCurlHeaderDump: string;
  let mockPermissionResult: boolean;

  const mockSlackService: Service = {
    name: 'slack',
    displayName: 'Slack',
    baseApiUrls: ['https://slack.com/api/'],
    loginUrl: 'https://slack.com/signin',
    info: 'Test Slack service.',
    credentialCheckCurlArguments: ['https://slack.com/api/auth.test'],
    checkApiCredentials: vi.fn().mockReturnValue(ApiCredentialStatus.Valid),
    setCredentialsExample(serviceName: string) {
      return `latchkey auth set ${serviceName} -H "Authorization: Bearer xoxb-your-token"`;
    },
    getCredentialsNoCurl() {
      throw new NoCurlCredentialsNotSupportedError('slack');
    },
  };

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
    credentialsData: Record<string, unknown> = {
      slack: { objectType: 'rawCurl', curlArguments: ['-H', 'Authorization: Bearer test-token'] },
    },
    overrides: Partial<CliDependencies> = {},
    optionOverrides: Partial<GatewayOptions> = {},
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
      runCurlAsync: async (
        args: readonly string[],
        options?: { stdin?: Buffer }
      ): Promise<AsyncCurlResult> => {
        capturedCurlArgs = args;
        capturedCurlStdin = options?.stdin;

        // Write mock header dump to the temp file if -D flag is present
        const dashDIndex = args.indexOf('-D');
        if (dashDIndex !== -1 && dashDIndex + 1 < args.length) {
          const headerFile = args[dashDIndex + 1]!;
          const { writeFileSync } = await import('node:fs');
          writeFileSync(headerFile, mockCurlHeaderDump);
        }

        return mockCurlResponse;
      },
      checkPermission: () => Promise.resolve(mockPermissionResult),
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
      port: 0, // auto-assign port
      host: 'localhost',
      maxBodySize: 10 * 1024 * 1024,
      ...optionOverrides,
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
    // Use the actual bound address to avoid IPv4/IPv6 mismatch
    const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
    return `http://${host}:${String(address.port)}`;
  }

  function fetch(path: string, options: RequestInit = {}): Promise<Response> {
    return globalThis.fetch(`${getHost()}${path}`, options);
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'latchkey-gw-test-'));
    logs = [];
    errorLogs = [];
    capturedCurlArgs = [];
    capturedCurlStdin = undefined;
    mockPermissionResult = true;
    mockCurlResponse = {
      returncode: 0,
      stdout: Buffer.from('{"ok":true}'),
      stderr: '',
    };
    mockCurlHeaderDump = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n';
  });

  afterEach(async () => {
    if (gateway) {
      await gateway.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('health endpoint', () => {
    it('should return status and version on GET /', async () => {
      gateway = await createTestGateway();
      const response = await fetch('/');

      expect(response.status).toBe(200);
      const body = (await response.json()) as { status: string; version: string };
      expect(body.status).toBe('ok');
      expect(body.version).toBe('0.0.0-test');
    });
  });

  describe('404 for unknown paths', () => {
    it('should return 404 for non-gateway, non-root paths', async () => {
      gateway = await createTestGateway();
      const response = await fetch('/unknown');

      expect(response.status).toBe(404);
    });
  });

  describe('proxy requests', () => {
    it('should proxy a GET request and forward response', async () => {
      gateway = await createTestGateway();

      const response = await fetch('/gateway/https://slack.com/api/auth.test');

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json');
      const body = await response.text();
      expect(body).toBe('{"ok":true}');

      // Verify curl was called with injected credentials
      expect(capturedCurlArgs).toContain('Authorization: Bearer test-token');
      expect(capturedCurlArgs).toContain('https://slack.com/api/auth.test');
    });

    it('should proxy a POST request with body', async () => {
      gateway = await createTestGateway();
      const requestBody = '{"channel":"C01","text":"hello"}';

      const response = await fetch('/gateway/https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
      });

      expect(response.status).toBe(200);

      // Verify method and body were forwarded
      expect(capturedCurlArgs).toContain('-X');
      expect(capturedCurlArgs).toContain('POST');
      expect(capturedCurlArgs).toContain('--data-binary');
      expect(capturedCurlArgs).toContain('@-');
      expect(capturedCurlStdin?.toString()).toBe(requestBody);
    });

    it('should forward query parameters in the target URL', async () => {
      gateway = await createTestGateway();

      await fetch('/gateway/https://slack.com/api/search.messages?query=hello&count=10');

      expect(capturedCurlArgs).toContain(
        'https://slack.com/api/search.messages?query=hello&count=10'
      );
    });

    it('should strip hop-by-hop headers from inbound request', async () => {
      gateway = await createTestGateway();

      await fetch('/gateway/https://slack.com/api/auth.test', {
        headers: {
          'Content-Type': 'application/json',
          Connection: 'keep-alive',
        },
      });

      // The Connection header should not be in curl args
      const headerArgs: string[] = [];
      for (let i = 0; i < capturedCurlArgs.length; i++) {
        if (capturedCurlArgs[i] === '-H' && i + 1 < capturedCurlArgs.length) {
          headerArgs.push(capturedCurlArgs[i + 1]!);
        }
      }
      expect(headerArgs.some((h) => h.toLowerCase().startsWith('connection:'))).toBe(false);
    });

    it('should forward upstream response headers', async () => {
      mockCurlHeaderDump =
        'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Custom-Header: custom-value\r\n\r\n';
      gateway = await createTestGateway();

      const response = await fetch('/gateway/https://slack.com/api/auth.test');

      expect(response.headers.get('x-custom-header')).toBe('custom-value');
    });

    it('should forward upstream status code', async () => {
      mockCurlHeaderDump = 'HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\n\r\n';
      mockCurlResponse = {
        returncode: 0,
        stdout: Buffer.from('not found'),
        stderr: '',
      };
      gateway = await createTestGateway();

      const response = await fetch('/gateway/https://slack.com/api/unknown');

      expect(response.status).toBe(404);
      expect(await response.text()).toBe('not found');
    });
  });

  describe('error handling', () => {
    it('should return 400 for unknown service', async () => {
      gateway = await createTestGateway();

      const response = await fetch('/gateway/https://unknown-api.example.com/test');

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('No service matches URL');
    });

    it('should return 400 for missing credentials', async () => {
      gateway = await createTestGateway({});

      const response = await fetch('/gateway/https://slack.com/api/auth.test');

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('No credentials found for slack');
    });

    it('should pass through unknown service when passthroughUnknown is enabled', async () => {
      mockCurlHeaderDump = 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n';
      mockCurlResponse = {
        returncode: 0,
        stdout: Buffer.from('passthrough response'),
        stderr: '',
      };

      gateway = await createTestGateway(
        {
          slack: {
            objectType: 'rawCurl',
            curlArguments: ['-H', 'Authorization: Bearer test-token'],
          },
        },
        {},
        {},
        { passthroughUnknown: true }
      );

      const response = await fetch('/gateway/https://unknown-api.example.com/test');

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toBe('passthrough response');

      // Should not contain any credential injection
      const headerArgs: string[] = [];
      for (let i = 0; i < capturedCurlArgs.length; i++) {
        if (capturedCurlArgs[i] === '-H' && i + 1 < capturedCurlArgs.length) {
          headerArgs.push(capturedCurlArgs[i + 1]!);
        }
      }
      expect(headerArgs.some((h) => h.includes('Authorization: Bearer test-token'))).toBe(false);
    });

    it('should pass through missing credentials when passthroughUnknown is enabled', async () => {
      mockCurlHeaderDump = 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n';
      mockCurlResponse = {
        returncode: 0,
        stdout: Buffer.from('no-creds response'),
        stderr: '',
      };

      gateway = await createTestGateway({}, {}, {}, { passthroughUnknown: true });

      const response = await fetch('/gateway/https://slack.com/api/auth.test');

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toBe('no-creds response');
    });

    it('should still inject credentials for known services when passthroughUnknown is enabled', async () => {
      gateway = await createTestGateway(
        {
          slack: {
            objectType: 'rawCurl',
            curlArguments: ['-H', 'Authorization: Bearer test-token'],
          },
        },
        {},
        {},
        { passthroughUnknown: true }
      );

      const response = await fetch('/gateway/https://slack.com/api/auth.test');

      expect(response.status).toBe(200);
      expect(capturedCurlArgs).toContain('Authorization: Bearer test-token');
    });

    it('should return 400 for invalid target URL scheme', async () => {
      gateway = await createTestGateway();

      const response = await fetch('/gateway/ftp://example.com/file');

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('Could not extract URL');
    });

    it('should return 403 for permission denied', async () => {
      mockPermissionResult = false;
      gateway = await createTestGateway();

      const response = await fetch('/gateway/https://slack.com/api/auth.test');

      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('not permitted');
    });

    it('should return 413 for oversized body', async () => {
      gateway = await createTestGateway(
        {
          slack: {
            objectType: 'rawCurl',
            curlArguments: ['-H', 'Authorization: Bearer test-token'],
          },
        },
        {},
        { maxBodySize: 10 }
      );

      const response = await fetch('/gateway/https://slack.com/api/chat.postMessage', {
        method: 'POST',
        body: 'x'.repeat(100),
      });

      expect(response.status).toBe(413);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('body too large');
    });

    it('should return 502 for curl failure with no headers', async () => {
      mockCurlResponse = {
        returncode: 7,
        stdout: Buffer.from(''),
        stderr: 'Failed to connect',
      };
      // Don't write any header file
      gateway = await createTestGateway(
        {
          slack: {
            objectType: 'rawCurl',
            curlArguments: ['-H', 'Authorization: Bearer test-token'],
          },
        },
        {
          runCurlAsync: (args: readonly string[]): Promise<AsyncCurlResult> => {
            capturedCurlArgs = args;
            return Promise.resolve(mockCurlResponse);
          },
        }
      );

      const response = await fetch('/gateway/https://slack.com/api/auth.test');

      expect(response.status).toBe(502);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('Upstream request failed');
    });
  });

  describe('logging', () => {
    it('should log startup message', async () => {
      gateway = await createTestGateway();

      expect(logs.some((l) => l.includes('Latchkey gateway listening on'))).toBe(true);
    });

    it('should log request with status', async () => {
      gateway = await createTestGateway();

      await fetch('/gateway/https://slack.com/api/auth.test');

      expect(logs.some((l) => l.includes('GET') && l.includes('200'))).toBe(true);
    });
  });

  describe('concurrent requests', () => {
    it('should handle multiple concurrent requests', async () => {
      let requestCount = 0;
      gateway = await createTestGateway(
        {
          slack: {
            objectType: 'rawCurl',
            curlArguments: ['-H', 'Authorization: Bearer test-token'],
          },
        },
        {
          runCurlAsync: async (args: readonly string[]): Promise<AsyncCurlResult> => {
            requestCount++;
            const dashDIndex = args.indexOf('-D');
            if (dashDIndex !== -1 && dashDIndex + 1 < args.length) {
              const { writeFileSync } = await import('node:fs');
              writeFileSync(
                args[dashDIndex + 1]!,
                'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n'
              );
            }
            // Small delay to ensure concurrency
            await new Promise((resolve) => setTimeout(resolve, 50));
            return {
              returncode: 0,
              stdout: Buffer.from(`response-${String(requestCount)}`),
              stderr: '',
            };
          },
        }
      );

      const responses = await Promise.all([
        fetch('/gateway/https://slack.com/api/test1'),
        fetch('/gateway/https://slack.com/api/test2'),
        fetch('/gateway/https://slack.com/api/test3'),
      ]);

      for (const response of responses) {
        expect(response.status).toBe(200);
      }
    });
  });

  describe('shutdown', () => {
    it('should shut down cleanly', async () => {
      gateway = await createTestGateway();
      const baseUrl = getHost();

      await gateway.close();

      expect(logs.some((l) => l.includes('Shutting down'))).toBe(true);

      // Verify server is no longer accepting connections
      await expect(globalThis.fetch(`${baseUrl}/`)).rejects.toThrow();

      // Prevent double-close in afterEach
      gateway = undefined;
    });
  });
});

// ─── CLI Command Tests ────────────────────────────────────────────────────────

describe('gateway CLI command registration', () => {
  it('should register the gateway command', () => {
    const program = new Command();
    program.exitOverride();

    const logs: string[] = [];
    const errorLogs: string[] = [];

    const mockDeps: CliDependencies = {
      registry: new Registry([]),
      config: new Config(() => undefined),
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
    };

    registerCommands(program, mockDeps);

    const gatewayCommand = program.commands.find((c) => c.name() === 'gateway');
    expect(gatewayCommand).toBeDefined();
    expect(gatewayCommand!.description()).toContain('gateway');
  });
});
