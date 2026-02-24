import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, ExecSyncOptionsWithStringEncoding } from 'node:child_process';
import { Command } from 'commander';
import { registerCommands, type CliDependencies } from '../src/cliCommands.js';
import { extractUrlFromCurlArguments } from '../src/curl.js';
import { EncryptedStorage } from '../src/encryptedStorage.js';
import { Config } from '../src/config.js';
import { Registry } from '../src/registry.js';
import { ApiCredentialStatus } from '../src/apiCredentials.js';
import { SlackApiCredentials } from '../src/services/slack.js';
import { NoCurlCredentialsNotSupportedError, Service } from '../src/services/base.js';
import { GITLAB } from '../src/services/gitlab.js';
import { TELEGRAM } from '../src/services/telegram.js';
import { loadRegisteredServices, saveRegisteredService } from '../src/configDataStore.js';
import { loadRegisteredServicesIntoRegistry } from '../src/registry.js';
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
  LATCHKEY_DIRECTORY: string;
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
    const directory = overrides.directory ?? tempDir;
    return {
      directory,
      get credentialStorePath() {
        return join(directory, 'credentials.json');
      },
      get browserStatePath() {
        return join(directory, 'browser_state.json');
      },
      get configPath() {
        return join(directory, 'config.json');
      },
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
      setCredentialsExample(serviceName: string) {
        return `latchkey auth set ${serviceName} -H "Authorization: Bearer xoxb-your-token"`;
      },
      getCredentialsNoCurl() {
        throw new NoCurlCredentialsNotSupportedError('slack');
      },
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

      const deps = createMockDependencies();
      await runCommand(['services', 'info', 'slack'], deps);

      expect(logs).toHaveLength(1);
      const info = JSON.parse(logs[0] ?? '') as Record<string, unknown>;
      expect(info.authOptions).toEqual(['browser', 'set']);
      expect(info.credentialStatus).toBe('missing');
      expect(info.setCredentialsExample).toBe(
        'latchkey auth set slack -H "Authorization: Bearer xoxb-your-token"'
      );
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
        setCredentialsExample(serviceName: string) {
          return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
        },
        getCredentialsNoCurl() {
          throw new NoCurlCredentialsNotSupportedError('nologin');
        },
      };

      const deps = createMockDependencies({
        registry: new Registry([noLoginService]),
      });
      await runCommand(['services', 'info', 'nologin'], deps);

      const info = JSON.parse(logs[0] ?? '') as Record<string, unknown>;
      expect(info.authOptions).toEqual(['set']);
    });

    it('should not list browser in authOptions when LATCHKEY_DISABLE_BROWSER is in effect', async () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(storePath, '{}');

      const deps = createMockDependencies({
        config: createMockConfig({ browserDisabled: true }),
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

      const deps = createMockDependencies();

      await runCommand(['services', 'info', 'slack'], deps);

      const info = JSON.parse(logs[0] ?? '') as Record<string, unknown>;
      expect(info.credentialStatus).toBe('valid');
    });

    it('should return error for unknown service', async () => {
      const deps = createMockDependencies();

      await runCommand(['services', 'info', 'unknown-service'], deps);

      expect(exitCode).toBe(1);
      expect(errorLogs.length).toBeGreaterThan(0);
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

      const deps = createMockDependencies();

      await runCommand(['auth', 'clear', 'slack'], deps);

      const storedData = JSON.parse(readSecureFile(storePath) ?? '{}') as StoredCredentials;
      expect(storedData.slack).toBeUndefined();
    });

    it('should return error for unknown service', async () => {
      const deps = createMockDependencies();

      await runCommand(['auth', 'clear', 'unknown-service'], deps);

      expect(exitCode).toBe(1);
      expect(errorLogs.length).toBeGreaterThan(0);
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

      const deps = createMockDependencies();

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

      const deps = createMockDependencies();

      await runCommand(['auth', 'clear', '-y'], deps);

      expect(existsSync(storePath)).toBe(false);
      expect(existsSync(browserStatePath)).toBe(false);
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

      const deps = createMockDependencies();
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

      const deps = createMockDependencies();
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

      const deps = createMockDependencies();
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

      const deps = createMockDependencies();

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
    });

    it('should return error when arguments lack curl switches', async () => {
      const deps = createMockDependencies();

      await runCommand(['auth', 'set', 'slack', 'my-raw-token-value'], deps);

      expect(exitCode).toBe(1);
    });

    it('should return error for unknown service', async () => {
      const deps = createMockDependencies();

      await runCommand(['auth', 'set', 'unknown-service', '-H', 'X-Token: secret'], deps);

      expect(exitCode).toBe(1);
    });

    it('should overwrite existing credentials', async () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(
        storePath,
        JSON.stringify({
          slack: { objectType: 'slack', token: 'old-token', dCookie: 'old-cookie' },
        })
      );

      const deps = createMockDependencies();

      await runCommand(['auth', 'set', 'slack', '-H', 'X-Token: new-secret'], deps);

      expect(logs).toContain('Credentials stored.');

      const storedData = JSON.parse(readSecureFile(storePath) ?? '{}') as Record<string, unknown>;
      expect(storedData.slack).toEqual({
        objectType: 'rawCurl',
        curlArguments: ['-H', 'X-Token: new-secret'],
      });
    });
  });

  describe('auth set-nocurl command', () => {
    it('should store telegram bot credentials', async () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(storePath, '{}');

      const deps = createMockDependencies({
        registry: new Registry([TELEGRAM]),
      });

      await runCommand(['auth', 'set-nocurl', 'telegram', '123456:ABC-DEF'], deps);

      expect(logs).toContain('Credentials stored.');

      const storedData = JSON.parse(readSecureFile(storePath) ?? '{}') as Record<string, unknown>;
      expect(storedData.telegram).toEqual({
        objectType: 'telegramBot',
        token: '123456:ABC-DEF',
      });
    });

    it('should return error for unknown service', async () => {
      const deps = createMockDependencies();

      await runCommand(['auth', 'set-nocurl', 'unknown-service', 'some-arg'], deps);

      expect(exitCode).toBe(1);
    });

    it('should return error when service does not support set-nocurl', async () => {
      const deps = createMockDependencies();

      await runCommand(['auth', 'set-nocurl', 'slack', 'some-token'], deps);

      expect(exitCode).toBe(1);
    });

    it('should return error when telegram token is missing', async () => {
      const deps = createMockDependencies({
        registry: new Registry([TELEGRAM]),
      });

      await runCommand(['auth', 'set-nocurl', 'telegram'], deps);

      expect(exitCode).toBe(1);
    });

    it('should return error when telegram token format is invalid', async () => {
      const deps = createMockDependencies({
        registry: new Registry([TELEGRAM]),
      });

      await runCommand(['auth', 'set-nocurl', 'telegram', 'not-a-valid-token'], deps);

      expect(exitCode).toBe(1);
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

      const deps = createMockDependencies();

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

      const deps = createMockDependencies();

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

      const deps = createMockDependencies();

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
        runCurl: (): CurlResult => ({ returncode: 42, stdout: '', stderr: '' }),
      });

      await runCommand(['curl', 'https://slack.com/api/test'], deps);

      expect(exitCode).toBe(42);
    });

    it('should return error when no URL found', async () => {
      const deps = createMockDependencies();

      await runCommand(['curl', '--', '-X', 'POST'], deps);

      expect(exitCode).toBe(1);
    });

    it('should return error for unknown service', async () => {
      const deps = createMockDependencies();

      await runCommand(['curl', 'https://unknown-api.example.com'], deps);

      expect(exitCode).toBe(1);
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
        setCredentialsExample(serviceName: string) {
          return `latchkey auth set ${serviceName} -H "Authorization: Bearer xoxb-your-token"`;
        },
        getCredentialsNoCurl() {
          throw new NoCurlCredentialsNotSupportedError('slack');
        },
        getSession: vi.fn().mockReturnValue({ login: mockLogin }),
      };

      const deps = createMockDependencies({
        registry: new Registry([mockSlackService]),
      });

      await runCommand(['curl', 'https://slack.com/api/test'], deps);

      expect(mockLogin).not.toHaveBeenCalled();
      expect(capturedArgs).toContain('Authorization: Bearer stored-token');
    });

    it('should return error when no credentials in store', async () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(storePath, '{}');

      const deps = createMockDependencies();

      await runCommand(['curl', 'https://slack.com/api/test'], deps);

      expect(exitCode).toBe(1);
    });

    it('should inject telegram bot token into URL path', async () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(
        storePath,
        JSON.stringify({
          telegram: { objectType: 'telegramBot', token: '123456:ABC-DEF' },
        })
      );

      const deps = createMockDependencies({
        registry: new Registry([TELEGRAM]),
      });

      await runCommand(['curl', 'https://api.telegram.org/getMe'], deps);

      expect(capturedArgs).toEqual(['https://api.telegram.org/bot123456:ABC-DEF/getMe']);
      expect(exitCode).toBe(0);
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
        setCredentialsExample(serviceName: string) {
          return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
        },
        getCredentialsNoCurl() {
          throw new NoCurlCredentialsNotSupportedError('nologin');
        },
        // No getSession - service doesn't support browser login
      };

      const deps = createMockDependencies({
        registry: new Registry([noLoginService]),
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
        setCredentialsExample(serviceName: string) {
          return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
        },
        // eslint-disable-next-line @typescript-eslint/unbound-method
        getCredentialsNoCurl: Service.prototype.getCredentialsNoCurl,
        // No getSession - service doesn't support browser login
      };

      const deps = createMockDependencies({
        registry: new Registry([noLoginService]),
      });

      await runCommand(['auth', 'browser', 'nologin'], deps);

      expect(exitCode).toBe(1);
    });

    it('should suggest set-nocurl when service supports nocurl credentials', async () => {
      const nocurlService: Service = {
        name: 'nocurl-only',
        displayName: 'NoCurl Only Service',
        baseApiUrls: ['https://nocurl.example.com/api/'],
        loginUrl: 'https://nocurl.example.com',
        info: 'A service with nocurl credentials but no browser login.',
        credentialCheckCurlArguments: [],
        checkApiCredentials: vi.fn(),
        setCredentialsExample(serviceName: string) {
          return `latchkey auth set-nocurl ${serviceName} <some-arg>`;
        },
        getCredentialsNoCurl(arguments_: readonly string[]) {
          if (arguments_.length !== 1) {
            throw new Error('Expected exactly one argument');
          }
          return { objectType: 'test', injectIntoCurlCall: vi.fn(), isExpired: () => false };
        },
        // No getSession - service doesn't support browser login
      };

      const deps = createMockDependencies({
        registry: new Registry([nocurlService]),
      });

      await runCommand(['auth', 'browser', 'nocurl-only'], deps);

      expect(exitCode).toBe(1);
    });
  });

  describe('services register command', () => {
    it('should register a new service', async () => {
      const deps = createMockDependencies({
        registry: new Registry([GITLAB]),
      });

      await runCommand(
        [
          'services',
          'register',
          'my-gitlab',
          '--base-api-url',
          'https://gitlab.mycompany.com/api/',
          '--service-family',
          'gitlab',
        ],
        deps
      );

      expect(exitCode).toBeNull();
      expect(logs).toContain("Service 'my-gitlab' registered.");

      // Should be findable by name
      expect(deps.registry.getByName('my-gitlab')).not.toBeNull();

      // Should be findable by URL
      expect(deps.registry.getByUrl('https://gitlab.mycompany.com/api/v4/user')).not.toBeNull();
    });

    it('should persist registration to config.json', async () => {
      const deps = createMockDependencies({
        registry: new Registry([GITLAB]),
      });

      await runCommand(
        [
          'services',
          'register',
          'my-gitlab',
          '--base-api-url',
          'https://gitlab.mycompany.com/api/',
          '--service-family',
          'gitlab',
        ],
        deps
      );

      const configPath = deps.config.configPath;
      const entries = loadRegisteredServices(configPath);
      expect(entries.get('my-gitlab')).toEqual({
        baseApiUrl: 'https://gitlab.mycompany.com/api/',
        serviceFamily: 'gitlab',
      });
    });

    it('should reject unknown service family', async () => {
      const deps = createMockDependencies({
        registry: new Registry([GITLAB]),
      });

      await runCommand(
        [
          'services',
          'register',
          'my-service',
          '--base-api-url',
          'https://example.com/api/',
          '--service-family',
          'nonexistent',
        ],
        deps
      );

      expect(exitCode).toBe(1);
      expect(errorLogs[0]).toContain('Unknown service family');
    });

    it('should reject duplicate service name', async () => {
      const deps = createMockDependencies({
        registry: new Registry([GITLAB]),
      });

      await runCommand(
        [
          'services',
          'register',
          'gitlab',
          '--base-api-url',
          'https://gitlab.mycompany.com/api/',
          '--service-family',
          'gitlab',
        ],
        deps
      );

      expect(exitCode).toBe(1);
      expect(errorLogs[0]).toContain('already exists');
    });

    it('should not expose browser auth without --login-url', async () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(storePath, '{}');

      const deps = createMockDependencies({
        registry: new Registry([GITLAB]),
      });

      await runCommand(
        [
          'services',
          'register',
          'my-gitlab',
          '--base-api-url',
          'https://gitlab.mycompany.com/api/',
          '--service-family',
          'gitlab',
        ],
        deps
      );

      logs = [];
      exitCode = null;
      await runCommand(['services', 'info', 'my-gitlab'], deps);

      const info = JSON.parse(logs[0] ?? '') as Record<string, unknown>;
      expect(info.authOptions).toEqual(['set']);
    });

    it('should persist and restore loginUrl', async () => {
      const deps = createMockDependencies({
        registry: new Registry([GITLAB]),
      });

      await runCommand(
        [
          'services',
          'register',
          'my-gitlab',
          '--base-api-url',
          'https://gitlab.mycompany.com/api/',
          '--service-family',
          'gitlab',
          '--login-url',
          'https://gitlab.mycompany.com/users/sign_in',
        ],
        deps
      );

      const entries = loadRegisteredServices(deps.config.configPath);
      expect(entries.get('my-gitlab')?.loginUrl).toBe('https://gitlab.mycompany.com/users/sign_in');
    });

    it('should make registered service usable with auth set', async () => {
      const deps = createMockDependencies({
        registry: new Registry([GITLAB]),
      });

      // Register the service
      await runCommand(
        [
          'services',
          'register',
          'my-gitlab',
          '--base-api-url',
          'https://gitlab.mycompany.com/api/',
          '--service-family',
          'gitlab',
        ],
        deps
      );

      // Now store credentials for it
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(storePath, '{}');

      logs = [];
      exitCode = null;
      await runCommand(['auth', 'set', 'my-gitlab', '-H', 'PRIVATE-TOKEN: my-secret-token'], deps);

      expect(exitCode).toBeNull();
      expect(logs).toContain('Credentials stored.');
    });

    it('should register a service without --service-family', async () => {
      const deps = createMockDependencies({
        registry: new Registry([GITLAB]),
      });

      await runCommand(
        ['services', 'register', 'my-api', '--base-api-url', 'https://api.example.com/'],
        deps
      );

      expect(exitCode).toBeNull();
      expect(logs).toContain("Service 'my-api' registered.");

      // Should be findable by name
      expect(deps.registry.getByName('my-api')).not.toBeNull();

      // Should be findable by URL
      expect(deps.registry.getByUrl('https://api.example.com/v1/users')).not.toBeNull();
    });

    it('should persist registration without service family to config.json', async () => {
      const deps = createMockDependencies({
        registry: new Registry([GITLAB]),
      });

      await runCommand(
        ['services', 'register', 'my-api', '--base-api-url', 'https://api.example.com/'],
        deps
      );

      const configPath = deps.config.configPath;
      const entries = loadRegisteredServices(configPath);
      expect(entries.get('my-api')).toEqual({
        baseApiUrl: 'https://api.example.com/',
      });
    });

    it('should not expose browser auth for service without family', async () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(storePath, '{}');

      const deps = createMockDependencies({
        registry: new Registry([GITLAB]),
      });

      await runCommand(
        ['services', 'register', 'my-api', '--base-api-url', 'https://api.example.com/'],
        deps
      );

      logs = [];
      exitCode = null;
      await runCommand(['services', 'info', 'my-api'], deps);

      const info = JSON.parse(logs[0] ?? '') as Record<string, unknown>;
      expect(info.authOptions).toEqual(['set']);
    });

    it('should make service without family usable with auth set and curl', async () => {
      const deps = createMockDependencies({
        registry: new Registry([GITLAB]),
      });

      // Register the service without family
      await runCommand(
        ['services', 'register', 'my-api', '--base-api-url', 'https://api.example.com/'],
        deps
      );

      // Store credentials
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(
        storePath,
        JSON.stringify({
          'my-api': {
            objectType: 'rawCurl',
            curlArguments: ['-H', 'Authorization: Bearer my-token'],
          },
        })
      );

      logs = [];
      exitCode = null;
      capturedArgs = [];
      await runCommand(['curl', 'https://api.example.com/v1/users'], deps);

      expect(exitCode).toBe(0);
      expect(capturedArgs).toContain('-H');
      expect(capturedArgs).toContain('Authorization: Bearer my-token');
    });

    it('should reject browser login for service without family', async () => {
      const deps = createMockDependencies({
        registry: new Registry([GITLAB]),
      });

      await runCommand(
        ['services', 'register', 'my-api', '--base-api-url', 'https://api.example.com/'],
        deps
      );

      logs = [];
      errorLogs = [];
      exitCode = null;
      await runCommand(['auth', 'browser', 'my-api'], deps);

      expect(exitCode).toBe(1);
      expect(errorLogs[0]).toContain('does not support browser flows');
    });

    it('should reject set-nocurl for service without family', async () => {
      const deps = createMockDependencies({
        registry: new Registry([GITLAB]),
      });

      await runCommand(
        ['services', 'register', 'my-api', '--base-api-url', 'https://api.example.com/'],
        deps
      );

      logs = [];
      errorLogs = [];
      exitCode = null;
      await runCommand(['auth', 'set-nocurl', 'my-api', 'some-token'], deps);

      expect(exitCode).toBe(1);
      expect(errorLogs[0]).toContain('does not support set-nocurl');
    });

    it('should make registered service usable with curl', async () => {
      const deps = createMockDependencies({
        registry: new Registry([GITLAB]),
      });

      // Register the service
      await runCommand(
        [
          'services',
          'register',
          'my-gitlab',
          '--base-api-url',
          'https://gitlab.mycompany.com/api/',
          '--service-family',
          'gitlab',
        ],
        deps
      );

      // Store credentials
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(
        storePath,
        JSON.stringify({
          'my-gitlab': {
            objectType: 'rawCurl',
            curlArguments: ['-H', 'PRIVATE-TOKEN: my-secret-token'],
          },
        })
      );

      logs = [];
      exitCode = null;
      capturedArgs = [];
      await runCommand(['curl', 'https://gitlab.mycompany.com/api/v4/user'], deps);

      expect(exitCode).toBe(0);
      expect(capturedArgs).toContain('-H');
      expect(capturedArgs).toContain('PRIVATE-TOKEN: my-secret-token');
    });
  });
});

describe('registeredServiceStore', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'latchkey-store-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should save and load registered services', () => {
    const configPath = join(tempDir, 'config.json');

    saveRegisteredService(configPath, 'my-gitlab', {
      baseApiUrl: 'https://gitlab.mycompany.com/api/',
      serviceFamily: 'gitlab',
    });

    const entries = loadRegisteredServices(configPath);
    expect(entries.size).toBe(1);
    expect(entries.get('my-gitlab')).toEqual({
      baseApiUrl: 'https://gitlab.mycompany.com/api/',
      serviceFamily: 'gitlab',
    });
  });

  it('should return empty map for nonexistent config file', () => {
    const configPath = join(tempDir, 'nonexistent.json');
    const entries = loadRegisteredServices(configPath);
    expect(entries.size).toBe(0);
  });

  it('should preserve existing config data when saving', () => {
    const configPath = join(tempDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ browser: { executablePath: '/usr/bin/chrome' } }));

    saveRegisteredService(configPath, 'my-gitlab', {
      baseApiUrl: 'https://gitlab.mycompany.com/api/',
      serviceFamily: 'gitlab',
    });

    const content = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(content.browser).toEqual({ executablePath: '/usr/bin/chrome' });
    expect(content.registeredServices).toBeDefined();
  });

  it('should load registered services into registry', () => {
    const configPath = join(tempDir, 'config.json');
    saveRegisteredService(configPath, 'my-gitlab', {
      baseApiUrl: 'https://gitlab.mycompany.com/api/',
      serviceFamily: 'gitlab',
    });

    const registry = new Registry([GITLAB]);
    loadRegisteredServicesIntoRegistry(configPath, registry);

    const service = registry.getByName('my-gitlab');
    expect(service).not.toBeNull();
    expect(service!.baseApiUrls).toEqual(['https://gitlab.mycompany.com/api/']);
  });

  it('should load registered service with loginUrl into registry', () => {
    const configPath = join(tempDir, 'config.json');
    saveRegisteredService(configPath, 'my-gitlab', {
      baseApiUrl: 'https://gitlab.mycompany.com/api/',
      serviceFamily: 'gitlab',
      loginUrl: 'https://gitlab.mycompany.com/users/sign_in',
    });

    const registry = new Registry([GITLAB]);
    loadRegisteredServicesIntoRegistry(configPath, registry);

    const service = registry.getByName('my-gitlab');
    expect(service).not.toBeNull();
    expect(service!.loginUrl).toBe('https://gitlab.mycompany.com/users/sign_in');
  });

  it('should load registered service without family into registry', () => {
    const configPath = join(tempDir, 'config.json');
    saveRegisteredService(configPath, 'my-api', {
      baseApiUrl: 'https://api.example.com/',
    });

    const registry = new Registry([GITLAB]);
    loadRegisteredServicesIntoRegistry(configPath, registry);

    const service = registry.getByName('my-api');
    expect(service).not.toBeNull();
    expect(service!.baseApiUrls).toEqual(['https://api.example.com/']);
    expect(service!.getSession).toBeUndefined(); // eslint-disable-line @typescript-eslint/unbound-method
    expect(service!.loginUrl).toBe('');
  });

  it('should skip registered services with unknown family', () => {
    const configPath = join(tempDir, 'config.json');
    saveRegisteredService(configPath, 'my-unknown', {
      baseApiUrl: 'https://unknown.example.com/api/',
      serviceFamily: 'nonexistent',
    });

    const registry = new Registry([GITLAB]);
    loadRegisteredServicesIntoRegistry(configPath, registry);

    expect(registry.getByName('my-unknown')).toBeNull();
  });
});

// Integration tests that run the actual CLI binary.
// Only tests that exercise behavior not covered by the DI unit tests above.
describe.skipIf(!cliPath)('CLI integration tests (subprocess)', () => {
  let tempDir: string;
  let testEnv: TestEnv;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'latchkey-cli-test-'));
    testEnv = {
      LATCHKEY_DIRECTORY: tempDir,
    };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return non-zero exit code for unknown service URL', () => {
    const result = runCli(['curl', 'https://unknown-api.example.com'], testEnv);
    expect(result.exitCode).toBe(1);
  });

  it('should return error when browser is disabled via LATCHKEY_DISABLE_BROWSER', () => {
    const result = runCli(['auth', 'browser', 'slack'], {
      ...testEnv,
      LATCHKEY_DISABLE_BROWSER: '1',
    });
    expect(result.exitCode).toBe(1);
  });

  it('should list services as JSON', () => {
    const result = runCli(['services', 'list'], testEnv);
    expect(result.exitCode).toBe(0);

    const services = JSON.parse(result.stdout.trim()) as string[];
    expect(services).toContain('slack');
    expect(services).toContain('github');
  });
});
