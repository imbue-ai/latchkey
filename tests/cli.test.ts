import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, ExecSyncOptionsWithStringEncoding } from 'node:child_process';
import { Command } from 'commander';
import { registerCommands, type CliDependencies } from '../src/cliCommands.js';
import { extractUrlFromCurlArguments } from '../src/curl.js';
import { BrowserFlowsNotSupportedError } from '../src/playwrightUtils.js';
import { EncryptedStorage } from '../src/encryptedStorage.js';
import { Config } from '../src/config.js';
import { Registry } from '../src/registry.js';
import { SlackApiCredentials, ApiCredentialStatus } from '../src/apiCredentials.js';
import type { Service } from '../src/services/base.js';
import type { CurlResult } from '../src/curl.js';

// Use a fixed test key for deterministic test behavior (32 bytes = 256 bits, base64 encoded)
const TEST_ENCRYPTION_KEY = 'dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleXRlc3Q=';

function writeSecureFile(path: string, content: string): void {
  const storage = new EncryptedStorage({ encryptionKeyOverride: TEST_ENCRYPTION_KEY });
  storage.writeFile(path, content);
}

function readSecureFile(path: string): string | null {
  const storage = new EncryptedStorage({ encryptionKeyOverride: TEST_ENCRYPTION_KEY });
  return storage.readFile(path);
}

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface ExecError {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface StoredCredentials {
  slack?: { objectType: string; token: string; d_cookie: string };
  discord?: { objectType: string; token: string };
  [key: string]: unknown;
}

function getCliPath(): string | null {
  const projectRoot = join(__dirname, '..');
  // Check both possible paths based on tsconfig setup
  const pathWithSrc = join(projectRoot, 'dist', 'src', 'cli.js');
  const pathWithoutSrc = join(projectRoot, 'dist', 'cli.js');

  if (existsSync(pathWithSrc)) {
    return pathWithSrc;
  }
  if (existsSync(pathWithoutSrc)) {
    return pathWithoutSrc;
  }
  return null;
}

const cliPath = getCliPath();

interface TestEnv {
  LATCHKEY_STORE: string;
  LATCHKEY_BROWSER_STATE: string;
  LATCHKEY_DISABLE_BROWSER?: string;
}

function runCli(args: string[], env: TestEnv): CliResult {
  const options: ExecSyncOptionsWithStringEncoding = {
    cwd: join(__dirname, '..'),
    encoding: 'utf-8',
    env: {
      ...process.env,
      LATCHKEY_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  };

  try {
    if (!cliPath) {
      throw new Error('CLI not built');
    }
    const stdout = execSync(`node ${cliPath} ${args.join(' ')}`, options);
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error) {
    const execError = error as ExecError;
    return {
      exitCode: execError.status,
      stdout: execError.stdout,
      stderr: execError.stderr,
    };
  }
}

describe('extractUrlFromCurlArguments', () => {
  it('should extract URL from simple arguments', () => {
    const arguments_ = ['https://example.com'];
    expect(extractUrlFromCurlArguments(arguments_)).toBe('https://example.com');
  });

  it('should extract URL with http scheme', () => {
    const arguments_ = ['http://example.com'];
    expect(extractUrlFromCurlArguments(arguments_)).toBe('http://example.com');
  });

  it('should extract URL after options', () => {
    const arguments_ = ['-X', 'POST', 'https://api.example.com'];
    expect(extractUrlFromCurlArguments(arguments_)).toBe('https://api.example.com');
  });

  it('should extract URL with headers', () => {
    const arguments_ = ['-H', 'Content-Type: application/json', 'https://api.example.com'];
    expect(extractUrlFromCurlArguments(arguments_)).toBe('https://api.example.com');
  });

  it('should extract URL with data', () => {
    const arguments_ = ['-d', '{"key": "value"}', 'https://api.example.com'];
    expect(extractUrlFromCurlArguments(arguments_)).toBe('https://api.example.com');
  });

  it('should extract URL with long options', () => {
    const arguments_ = ['--header', 'Authorization: Bearer token', 'https://api.example.com'];
    expect(extractUrlFromCurlArguments(arguments_)).toBe('https://api.example.com');
  });

  it('should return null when no URL is present', () => {
    const arguments_ = ['-X', 'POST', '-H', 'Content-Type: application/json'];
    expect(extractUrlFromCurlArguments(arguments_)).toBeNull();
  });

  it('should return null for empty arguments', () => {
    const arguments_: string[] = [];
    expect(extractUrlFromCurlArguments(arguments_)).toBeNull();
  });

  it('should handle verbose flag', () => {
    let arguments_ = ['-v', 'https://api.example.com'];
    expect(extractUrlFromCurlArguments(arguments_)).toBe('https://api.example.com');

    arguments_ = ['--verbose', 'https://api.example.com'];
    expect(extractUrlFromCurlArguments(arguments_)).toBe('https://api.example.com');

    arguments_ = ['-v', '-X', 'POST', 'https://api.example.com'];
    expect(extractUrlFromCurlArguments(arguments_)).toBe('https://api.example.com');
  });

  it('should skip flags without values', () => {
    const arguments_ = ['-k', '--compressed', '-s', '-i', 'https://api.example.com'];
    expect(extractUrlFromCurlArguments(arguments_)).toBe('https://api.example.com');
  });
});

describe('CLI commands with dependency injection', () => {
  let tempDir: string;
  let capturedArgs: string[];
  let logs: string[];
  let errorLogs: string[];
  let exitCode: number | null;

  function createMockConfig(overrides: Partial<Config> = {}): Config {
    const defaultConfig = new Config(() => undefined);
    return {
      credentialStorePath: overrides.credentialStorePath ?? join(tempDir, 'credentials.json'),
      browserStatePath: overrides.browserStatePath ?? join(tempDir, 'browser_state.json'),
      configPath: overrides.configPath ?? join(tempDir, 'config.json'),
      curlCommand: overrides.curlCommand ?? defaultConfig.curlCommand,
      encryptionKeyOverride: overrides.encryptionKeyOverride ?? TEST_ENCRYPTION_KEY,
      serviceName: overrides.serviceName ?? defaultConfig.serviceName,
      accountName: overrides.accountName ?? defaultConfig.accountName,
      browserDisabled: overrides.browserDisabled ?? false,
      checkSensitiveFilePermissions: () => undefined,
      checkSystemPrerequisites: () => undefined,
    };
  }

  function createMockDependencies(overrides: Partial<CliDependencies> = {}): CliDependencies {
    const mockSlackService: Service = {
      name: 'slack',
      displayName: 'Slack',
      baseApiUrls: ['https://slack.com/api/'],
      loginUrl: 'https://slack.com/signin',
      info: 'Test info for Slack service.',
      credentialCheckCurlArguments: ['https://slack.com/api/auth.test'],
      checkApiCredentials: vi.fn().mockReturnValue(ApiCredentialStatus.Valid),
      getSession: vi.fn().mockReturnValue({
        login: vi.fn().mockResolvedValue(new SlackApiCredentials('xoxc-test-token', 'test-cookie')),
      }),
    };

    const mockRegistry = new Registry([mockSlackService]);

    return {
      registry: mockRegistry,
      config: createMockConfig(),
      runCurl: (args: readonly string[]): CurlResult => {
        capturedArgs.push(...args);
        return { returncode: 0, stdout: '', stderr: '' };
      },
      confirm: () => Promise.resolve(true),
      exit: (code: number): never => {
        exitCode = code;
        throw new Error(`process.exit(${String(code)})`);
      },
      log: (message: string) => {
        logs.push(message);
      },
      errorLog: (message: string) => {
        errorLogs.push(message);
      },
      ...overrides,
    };
  }

  async function runCommand(args: string[], deps: CliDependencies): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerCommands(program, deps);
    try {
      await program.parseAsync(['node', 'latchkey', ...args]);
    } catch (error) {
      // Swallow exit errors since we capture the exit code
      if (!(error instanceof Error) || !error.message.startsWith('process.exit(')) {
        throw error;
      }
    }
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'latchkey-cli-test-'));
    capturedArgs = [];
    logs = [];
    errorLogs = [];
    exitCode = null;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('services list command', () => {
    it('should list all services as JSON', async () => {
      const deps = createMockDependencies();
      await runCommand(['services', 'list'], deps);

      expect(logs).toHaveLength(1);
      const services = JSON.parse(logs[0] ?? '') as string[];
      expect(services).toContain('slack');
    });
  });

  describe('services info command', () => {
    it('should show login options, credentials status, and developer notes', async () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(storePath, '{}');

      const deps = createMockDependencies({
        config: createMockConfig({ credentialStorePath: storePath }),
      });
      await runCommand(['services', 'info', 'slack'], deps);

      expect(logs).toHaveLength(1);
      const info = JSON.parse(logs[0] ?? '') as Record<string, unknown>;
      expect(info.authOptions).toEqual(['browser', 'set']);
      expect(info.credentialStatus).toBe('missing');
      expect(info.developerNotes).toBe('Test info for Slack service.');
    });

    it('should show auth set only for services without browser login', async () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(storePath, '{}');

      const noLoginService: Service = {
        name: 'nologin',
        displayName: 'No Login Service',
        baseApiUrls: ['https://nologin.example.com/api/'],
        loginUrl: 'https://nologin.example.com',
        info: 'A service without browser login support.',
        credentialCheckCurlArguments: [],
        checkApiCredentials: vi.fn().mockReturnValue(ApiCredentialStatus.Missing),
      };

      const deps = createMockDependencies({
        registry: new Registry([noLoginService]),
        config: createMockConfig({ credentialStorePath: storePath }),
      });
      await runCommand(['services', 'info', 'nologin'], deps);

      const info = JSON.parse(logs[0] ?? '') as Record<string, unknown>;
      expect(info.authOptions).toEqual(['set']);
    });

    it('should not list browser in authOptions when LATCHKEY_DISABLE_BROWSER is in effect', async () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(storePath, '{}');

      const deps = createMockDependencies({
        config: createMockConfig({ credentialStorePath: storePath, browserDisabled: true }),
      });
      await runCommand(['services', 'info', 'slack'], deps);

      const info = JSON.parse(logs[0] ?? '') as Record<string, unknown>;
      expect(info.authOptions).toEqual(['set']);
    });

    it('should show valid credentials status when credentials are valid', async () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(
        storePath,
        JSON.stringify({
          slack: { objectType: 'slack', token: 'test-token', dCookie: 'test-cookie' },
        })
      );

      const deps = createMockDependencies({
        config: createMockConfig({ credentialStorePath: storePath }),
      });

      await runCommand(['services', 'info', 'slack'], deps);

      const info = JSON.parse(logs[0] ?? '') as Record<string, unknown>;
      expect(info.credentialStatus).toBe('valid');
    });

    it('should return error for unknown service', async () => {
      const deps = createMockDependencies();

      await runCommand(['services', 'info', 'unknown-service'], deps);

      expect(exitCode).toBe(1);
      expect(errorLogs.some((log) => log.includes('Unknown service'))).toBe(true);
    });
  });

  describe('clear command', () => {
    it('should delete credentials for a service', async () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(
        storePath,
        JSON.stringify({
          slack: { objectType: 'slack', token: 'test-token', dCookie: 'test-cookie' },
        })
      );

      const deps = createMockDependencies({
        config: createMockConfig({ credentialStorePath: storePath }),
      });

      await runCommand(['auth', 'clear', 'slack'], deps);

      expect(logs.some((log) => log.includes('have been cleared'))).toBe(true);
      const storedData = JSON.parse(readSecureFile(storePath) ?? '{}') as StoredCredentials;
      expect(storedData.slack).toBeUndefined();
    });

    it('should report no credentials found when service has no stored credentials', async () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(storePath, '{}');

      const deps = createMockDependencies({
        config: createMockConfig({ credentialStorePath: storePath }),
      });

      await runCommand(['auth', 'clear', 'slack'], deps);

      expect(logs.some((log) => log.includes('No API credentials found'))).toBe(true);
    });

    it('should return error for unknown service', async () => {
      const storePath = join(tempDir, 'credentials.json');

      const deps = createMockDependencies({
        config: createMockConfig({ credentialStorePath: storePath }),
      });

      await runCommand(['auth', 'clear', 'unknown-service'], deps);

      expect(exitCode).toBe(1);
      expect(errorLogs.some((log) => log.includes('Unknown service'))).toBe(true);
    });

    it('should use default config paths', async () => {
      const deps = createMockDependencies();

      await runCommand(['auth', 'clear', 'slack'], deps);

      // With default paths, should report no credentials found (not error about missing env var)
      expect(logs.some((log) => log.includes('No API credentials found'))).toBe(true);
    });

    it('should preserve other services when clearing one', async () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(
        storePath,
        JSON.stringify({
          slack: { objectType: 'slack', token: 'slack-token', dCookie: 'slack-cookie' },
          discord: { objectType: 'authorizationBare', token: 'discord-token' },
        })
      );

      const deps = createMockDependencies({
        config: createMockConfig({ credentialStorePath: storePath }),
      });

      await runCommand(['auth', 'clear', 'slack'], deps);

      const storedData = JSON.parse(readSecureFile(storePath) ?? '{}') as StoredCredentials;
      expect(storedData.slack).toBeUndefined();
      expect(storedData.discord).toBeDefined();
      expect(storedData.discord?.token).toBe('discord-token');
    });

    it('should delete both store and browser state with -y flag', async () => {
      const storePath = join(tempDir, 'credentials.json');
      const browserStatePath = join(tempDir, 'browser_state.json');
      writeSecureFile(
        storePath,
        JSON.stringify({ slack: { objectType: 'slack', token: 'test', dCookie: 'test' } })
      );
      writeSecureFile(browserStatePath, '{}');

      const deps = createMockDependencies({
        config: createMockConfig({ credentialStorePath: storePath, browserStatePath }),
      });

      await runCommand(['auth', 'clear', '-y'], deps);

      expect(existsSync(storePath)).toBe(false);
      expect(existsSync(browserStatePath)).toBe(false);
      expect(logs.some((log) => log.includes('Deleted credentials store'))).toBe(true);
      expect(logs.some((log) => log.includes('Deleted browser state'))).toBe(true);
    });

    it('should report no files to delete when none exist', async () => {
      const storePath = join(tempDir, 'nonexistent_store.json');
      const browserStatePath = join(tempDir, 'nonexistent_browser_state.json');

      const deps = createMockDependencies({
        config: createMockConfig({ credentialStorePath: storePath, browserStatePath }),
      });

      await runCommand(['auth', 'clear', '-y'], deps);

      expect(logs.some((log) => log.includes('No files to delete'))).toBe(true);
    });
  });

  describe('auth list command', () => {
    it('should list stored credentials with their status', async () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(
        storePath,
        JSON.stringify({
          slack: { objectType: 'slack', token: 'test-token', dCookie: 'test-cookie' },
        })
      );

      const deps = createMockDependencies({
        config: createMockConfig({ credentialStorePath: storePath }),
      });
      await runCommand(['auth', 'list'], deps);

      expect(logs).toHaveLength(1);
      const entries = JSON.parse(logs[0] ?? '') as Record<string, unknown>;
      expect(entries.slack).toEqual({
        credentialType: 'slack',
        credentialStatus: 'valid',
      });
    });

    it('should output empty object when no credentials are stored', async () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(storePath, '{}');

      const deps = createMockDependencies({
        config: createMockConfig({ credentialStorePath: storePath }),
      });
      await runCommand(['auth', 'list'], deps);

      expect(logs).toHaveLength(1);
      const entries = JSON.parse(logs[0] ?? '') as Record<string, unknown>;
      expect(Object.keys(entries)).toHaveLength(0);
    });

    it('should treat unknown services as valid', async () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(
        storePath,
        JSON.stringify({
          unknown: { objectType: 'rawCurl', curlArguments: ['-H', 'X-Token: secret'] },
        })
      );

      const deps = createMockDependencies({
        config: createMockConfig({ credentialStorePath: storePath }),
      });
      await runCommand(['auth', 'list'], deps);

      expect(logs).toHaveLength(1);
      const entries = JSON.parse(logs[0] ?? '') as Record<string, unknown>;
      expect(entries.unknown).toEqual({
        credentialType: 'rawCurl',
        credentialStatus: 'valid',
      });
    });
  });

  describe('auth set command', () => {
    it('should store raw curl credentials', async () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(storePath, '{}');

      const deps = createMockDependencies({
        config: createMockConfig({ credentialStorePath: storePath }),
      });

      await runCommand(
        ['auth', 'set', 'slack', '-H', 'X-Token: secret', '-H', 'X-Other: value'],
        deps
      );

      expect(logs).toContain('Credentials stored.');

      const storedData = JSON.parse(readSecureFile(storePath) ?? '{}') as Record<string, unknown>;
      expect(storedData.slack).toEqual({
        objectType: 'rawCurl',
        curlArguments: ['-H', 'X-Token: secret', '-H', 'X-Other: value'],
      });
    });

    it('should return error for empty curl arguments', async () => {
      const deps = createMockDependencies();

      await runCommand(['auth', 'set', 'slack'], deps);

      expect(exitCode).toBe(1);
      expect(errorLogs.some((log) => log.includes("don't look like valid curl options"))).toBe(
        true
      );
      expect(errorLogs.some((log) => log.includes('Authorization: Bearer'))).toBe(true);
    });

    it('should return error when arguments lack curl switches', async () => {
      const deps = createMockDependencies();

      await runCommand(['auth', 'set', 'slack', 'my-raw-token-value'], deps);

      expect(exitCode).toBe(1);
      expect(errorLogs.some((log) => log.includes("don't look like valid curl options"))).toBe(
        true
      );
      expect(errorLogs.some((log) => log.includes('Authorization: Bearer'))).toBe(true);
    });

    it('should return error for unknown service', async () => {
      const deps = createMockDependencies();

      await runCommand(['auth', 'set', 'unknown-service', '-H', 'X-Token: secret'], deps);

      expect(exitCode).toBe(1);
      expect(errorLogs.some((log) => log.includes('Unknown service'))).toBe(true);
    });

    it('should overwrite existing credentials', async () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(
        storePath,
        JSON.stringify({
          slack: { objectType: 'slack', token: 'old-token', dCookie: 'old-cookie' },
        })
      );

      const deps = createMockDependencies({
        config: createMockConfig({ credentialStorePath: storePath }),
      });

      await runCommand(['auth', 'set', 'slack', '-H', 'X-Token: new-secret'], deps);

      expect(logs).toContain('Credentials stored.');

      const storedData = JSON.parse(readSecureFile(storePath) ?? '{}') as Record<string, unknown>;
      expect(storedData.slack).toEqual({
        objectType: 'rawCurl',
        curlArguments: ['-H', 'X-Token: new-secret'],
      });
    });
  });

  describe('curl command', () => {
    it('should pass arguments to subprocess', async () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(
        storePath,
        JSON.stringify({
          slack: { objectType: 'slack', token: 'stored-token', dCookie: 'stored-cookie' },
        })
      );

      const deps = createMockDependencies({
        config: createMockConfig({ credentialStorePath: storePath }),
      });

      await runCommand(['curl', 'https://slack.com/api/test'], deps);

      expect(capturedArgs).toEqual([
        '-H',
        'Authorization: Bearer stored-token',
        '-H',
        'Cookie: d=stored-cookie',
        'https://slack.com/api/test',
      ]);
      expect(exitCode).toBe(0);
    });

    it('should pass raw curl credentials to subprocess', async () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(
        storePath,
        JSON.stringify({
          slack: { objectType: 'rawCurl', curlArguments: ['-H', 'X-Custom: header'] },
        })
      );

      const deps = createMockDependencies({
        config: createMockConfig({ credentialStorePath: storePath }),
      });

      await runCommand(['curl', 'https://slack.com/api/test'], deps);

      expect(capturedArgs).toEqual(['-H', 'X-Custom: header', 'https://slack.com/api/test']);
      expect(exitCode).toBe(0);
    });

    it('should pass multiple arguments correctly', async () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(
        storePath,
        JSON.stringify({
          slack: { objectType: 'slack', token: 'stored-token', dCookie: 'stored-cookie' },
        })
      );

      const deps = createMockDependencies({
        config: createMockConfig({ credentialStorePath: storePath }),
      });

      await runCommand(
        [
          'curl',
          '--',
          '-X',
          'POST',
          '-H',
          'Content-Type: application/json',
          'https://slack.com/api/test',
        ],
        deps
      );

      expect(capturedArgs).toContain('-X');
      expect(capturedArgs).toContain('POST');
      expect(capturedArgs).toContain('-H');
      expect(capturedArgs).toContain('Content-Type: application/json');
      expect(capturedArgs).toContain('https://slack.com/api/test');
      expect(capturedArgs).toContain('Authorization: Bearer stored-token');
    });

    it('should return subprocess exit code', async () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(
        storePath,
        JSON.stringify({
          slack: { objectType: 'slack', token: 'stored-token', dCookie: 'stored-cookie' },
        })
      );

      const deps = createMockDependencies({
        config: createMockConfig({ credentialStorePath: storePath }),
        runCurl: (): CurlResult => ({ returncode: 42, stdout: '', stderr: '' }),
      });

      await runCommand(['curl', 'https://slack.com/api/test'], deps);

      expect(exitCode).toBe(42);
    });

    it('should return error when no URL found', async () => {
      const deps = createMockDependencies();

      await runCommand(['curl', '--', '-X', 'POST'], deps);

      expect(exitCode).toBe(1);
      expect(errorLogs.some((log) => log.includes('Could not extract URL'))).toBe(true);
    });

    it('should return error for unknown service', async () => {
      const deps = createMockDependencies();

      await runCommand(['curl', 'https://unknown-api.example.com'], deps);

      expect(exitCode).toBe(1);
      expect(errorLogs.some((log) => log.includes('No service matches URL'))).toBe(true);
    });

    it('should inject credentials with verbose flag', async () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(
        storePath,
        JSON.stringify({
          slack: { objectType: 'slack', token: 'stored-token', dCookie: 'stored-cookie' },
        })
      );

      const deps = createMockDependencies({
        config: createMockConfig({ credentialStorePath: storePath }),
      });

      await runCommand(['curl', '--', '-v', 'https://slack.com/api/conversations.list'], deps);

      expect(capturedArgs).toContain('-v');
      expect(capturedArgs).toContain('Authorization: Bearer stored-token');
      expect(capturedArgs).toContain('https://slack.com/api/conversations.list');
    });

    it('should read credentials from store and not call login', async () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(
        storePath,
        JSON.stringify({
          slack: { objectType: 'slack', token: 'stored-token', dCookie: 'stored-cookie' },
        })
      );

      const mockLogin = vi.fn();
      const mockSlackService: Service = {
        name: 'slack',
        displayName: 'Slack',
        baseApiUrls: ['https://slack.com/api/'],
        loginUrl: 'https://slack.com/signin',
        info: 'Test info for Slack service.',
        credentialCheckCurlArguments: [],
        checkApiCredentials: vi.fn(),
        getSession: vi.fn().mockReturnValue({ login: mockLogin }),
      };

      const deps = createMockDependencies({
        registry: new Registry([mockSlackService]),
        config: createMockConfig({ credentialStorePath: storePath }),
      });

      await runCommand(['curl', 'https://slack.com/api/test'], deps);

      expect(mockLogin).not.toHaveBeenCalled();
      expect(capturedArgs).toContain('Authorization: Bearer stored-token');
    });

    it('should return error when no credentials in store', async () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(storePath, '{}');

      const deps = createMockDependencies({
        config: createMockConfig({ credentialStorePath: storePath }),
      });

      await runCommand(['curl', 'https://slack.com/api/test'], deps);

      expect(exitCode).toBe(1);
      expect(errorLogs.some((log) => log.includes('No credentials found for slack'))).toBe(true);
      expect(errorLogs.some((log) => log.includes('auth browser'))).toBe(true);
      expect(errorLogs.some((log) => log.includes('auth set'))).toBe(true);
    });

    it('should work when service does not have getSession but credentials exist', async () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(
        storePath,
        JSON.stringify({
          nologin: { objectType: 'rawCurl', curlArguments: ['-H', 'X-API-Key: secret'] },
        })
      );

      const noLoginService: Service = {
        name: 'nologin',
        displayName: 'No Login Service',
        baseApiUrls: ['https://nologin.example.com/api/'],
        loginUrl: 'https://nologin.example.com',
        info: 'A service without browser login support.',
        credentialCheckCurlArguments: [],
        checkApiCredentials: vi.fn().mockReturnValue(ApiCredentialStatus.Valid),
        // No getSession - service doesn't support browser login
      };

      const deps = createMockDependencies({
        registry: new Registry([noLoginService]),
        config: createMockConfig({ credentialStorePath: storePath }),
      });

      await runCommand(['curl', 'https://nologin.example.com/api/test'], deps);

      expect(exitCode).toBe(0);
      expect(capturedArgs).toContain('-H');
      expect(capturedArgs).toContain('X-API-Key: secret');
    });
  });

  describe('auth browser command', () => {
    it('should return error when service does not support browser login', async () => {
      const noLoginService: Service = {
        name: 'nologin',
        displayName: 'No Login Service',
        baseApiUrls: ['https://nologin.example.com/api/'],
        loginUrl: 'https://nologin.example.com',
        info: 'A service without browser login support.',
        credentialCheckCurlArguments: [],
        checkApiCredentials: vi.fn(),
        // No getSession - service doesn't support browser login
      };

      const deps = createMockDependencies({
        registry: new Registry([noLoginService]),
      });

      await runCommand(['auth', 'browser', 'nologin'], deps);

      expect(exitCode).toBe(1);
      const expectedMessage = new BrowserFlowsNotSupportedError('nologin').message;
      expect(errorLogs.some((log) => log.includes(expectedMessage))).toBe(true);
    });
  });
});

// Integration tests that run the actual CLI binary
describe.skipIf(!cliPath)('CLI integration tests (subprocess)', () => {
  let tempDir: string;
  let testEnv: TestEnv;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'latchkey-cli-test-'));
    testEnv = {
      LATCHKEY_STORE: join(tempDir, 'credentials.json'),
      LATCHKEY_BROWSER_STATE: join(tempDir, 'browser_state.json'),
    };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('curl command', () => {
    it('should return error when curl has no arguments', () => {
      const result = runCli(['curl'], testEnv);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Could not extract URL');
    });

    it('should return error when no URL found in curl arguments', () => {
      const result = runCli(['curl', '--', '-X', 'POST'], testEnv);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Could not extract URL');
    });

    it('should return error for unknown service', () => {
      const result = runCli(['curl', 'https://unknown-api.example.com'], testEnv);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No service matches URL');
      expect(result.stderr).toContain('https://unknown-api.example.com');
    });

    it('should return error when no credentials exist', () => {
      writeSecureFile(testEnv.LATCHKEY_STORE, '{}');
      const result = runCli(['curl', 'https://slack.com/api/test'], testEnv);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No credentials found for slack');
      expect(result.stderr).toContain('auth browser');
      expect(result.stderr).toContain('auth set');
    });
  });

  describe('auth browser command', () => {
    it('should return error when browser is disabled via LATCHKEY_DISABLE_BROWSER', () => {
      const result = runCli(['auth', 'browser', 'slack'], {
        ...testEnv,
        LATCHKEY_DISABLE_BROWSER: '1',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Browser is disabled');
    });
  });

  describe('clear command', () => {
    it('should delete credentials for a service', () => {
      writeSecureFile(
        testEnv.LATCHKEY_STORE,
        JSON.stringify({
          slack: { objectType: 'slack', token: 'test-token', dCookie: 'test-cookie' },
        })
      );

      const result = runCli(['auth', 'clear', 'slack'], testEnv);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('API credentials for slack have been cleared');

      const storedData = JSON.parse(
        readSecureFile(testEnv.LATCHKEY_STORE) ?? '{}'
      ) as StoredCredentials;
      expect(storedData.slack).toBeUndefined();
    });

    it('should report no credentials found when service has no stored credentials', () => {
      writeSecureFile(testEnv.LATCHKEY_STORE, '{}');

      const result = runCli(['auth', 'clear', 'slack'], testEnv);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No API credentials found for slack');
    });

    it('should return error for unknown service', () => {
      const result = runCli(['auth', 'clear', 'unknown-service'], testEnv);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown service: unknown-service');
    });

    it('should preserve other services when clearing one', () => {
      writeSecureFile(
        testEnv.LATCHKEY_STORE,
        JSON.stringify({
          slack: { objectType: 'slack', token: 'slack-token', dCookie: 'slack-cookie' },
          discord: { objectType: 'authorizationBare', token: 'discord-token' },
        })
      );

      const result = runCli(['auth', 'clear', 'slack'], testEnv);
      expect(result.exitCode).toBe(0);

      const storedData = JSON.parse(
        readSecureFile(testEnv.LATCHKEY_STORE) ?? '{}'
      ) as StoredCredentials;
      expect(storedData.slack).toBeUndefined();
      expect(storedData.discord).toBeDefined();
      expect(storedData.discord?.token).toBe('discord-token');
    });

    it('should delete both store and browser state with -y flag', () => {
      writeSecureFile(
        testEnv.LATCHKEY_STORE,
        JSON.stringify({ slack: { objectType: 'slack', token: 'test', dCookie: 'test' } })
      );
      writeSecureFile(testEnv.LATCHKEY_BROWSER_STATE, '{}');

      const result = runCli(['auth', 'clear', '-y'], testEnv);
      expect(result.exitCode).toBe(0);
      expect(existsSync(testEnv.LATCHKEY_STORE)).toBe(false);
      expect(existsSync(testEnv.LATCHKEY_BROWSER_STATE)).toBe(false);
      expect(result.stdout).toContain(`Deleted credentials store: ${testEnv.LATCHKEY_STORE}`);
      expect(result.stdout).toContain(`Deleted browser state: ${testEnv.LATCHKEY_BROWSER_STATE}`);
    });

    it('should delete only existing files with -y flag', () => {
      writeSecureFile(testEnv.LATCHKEY_STORE, '{}');
      // browser_state does not exist

      const result = runCli(['auth', 'clear', '-y'], testEnv);
      expect(result.exitCode).toBe(0);
      expect(existsSync(testEnv.LATCHKEY_STORE)).toBe(false);
      expect(result.stdout).toContain(`Deleted credentials store: ${testEnv.LATCHKEY_STORE}`);
      expect(result.stdout).not.toContain('browser state');
    });

    it('should report no files to delete when none exist', () => {
      const result = runCli(['auth', 'clear', '-y'], testEnv);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No files to delete');
    });
  });

  describe('auth list command', () => {
    it('should list stored credentials as beautified JSON', () => {
      writeSecureFile(
        testEnv.LATCHKEY_STORE,
        JSON.stringify({
          slack: { objectType: 'slack', token: 'test-token', dCookie: 'test-cookie' },
        })
      );

      const result = runCli(['auth', 'list'], testEnv);
      expect(result.exitCode).toBe(0);

      const entries = JSON.parse(result.stdout) as Record<
        string,
        { credentialType: string; credentialStatus: string }
      >;
      expect(entries.slack).toBeDefined();
      expect(entries.slack?.credentialType).toBe('slack');
      expect(entries.slack?.credentialStatus).toEqual(expect.any(String));
    });

    it('should output empty object when no credentials are stored', () => {
      writeSecureFile(testEnv.LATCHKEY_STORE, '{}');

      const result = runCli(['auth', 'list'], testEnv);
      expect(result.exitCode).toBe(0);

      const entries = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(Object.keys(entries)).toHaveLength(0);
    });
  });

  describe('services list command', () => {
    it('should list all services as JSON', () => {
      const result = runCli(['services', 'list'], testEnv);
      expect(result.exitCode).toBe(0);

      const services = JSON.parse(result.stdout.trim()) as string[];
      expect(services).toContain('slack');
      expect(services).toContain('discord');
      expect(services).toContain('github');
      expect(services).toContain('dropbox');
      expect(services).toContain('linear');
    });
  });

  describe('services info command', () => {
    it('should show login options, credentials status, and developer notes as JSON', () => {
      writeSecureFile(testEnv.LATCHKEY_STORE, '{}');

      const result = runCli(['services', 'info', 'slack'], testEnv);
      expect(result.exitCode).toBe(0);

      const info = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(info.authOptions).toEqual(['browser', 'set']);
      expect(info.credentialStatus).toBe('missing');
      expect(info.developerNotes).toEqual(expect.any(String));
    });

    it('should show auth set only for services without browser login', () => {
      writeSecureFile(testEnv.LATCHKEY_STORE, '{}');

      const result = runCli(['services', 'info', 'mailchimp'], testEnv);
      expect(result.exitCode).toBe(0);

      const info = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(info.authOptions).toEqual(['set']);
    });

    it('should return error for unknown service', () => {
      const result = runCli(['services', 'info', 'unknown-service'], testEnv);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown service');
    });
  });
});
