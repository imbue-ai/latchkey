import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function writeSecureFile(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
}
import { execSync, ExecSyncOptionsWithStringEncoding } from 'node:child_process';
import { Command } from 'commander';
import {
  extractUrlFromCurlArguments,
  registerCommands,
  type CliDependencies,
} from '../src/cliCommands.js';
import { BrowserStateStore } from '../src/browserState.js';
import { Config } from '../src/config.js';
import { Registry } from '../src/registry.js';
import { SlackApiCredentials, ApiCredentialStatus } from '../src/apiCredentials.js';
import type { Service } from '../src/services/base.js';
import type { CurlResult } from '../src/curl.js';

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

function runCli(args: string[], env: Record<string, string> = {}): CliResult {
  const options: ExecSyncOptionsWithStringEncoding = {
    cwd: join(__dirname, '..'),
    encoding: 'utf-8',
    env: { ...process.env, ...env },
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
      curlCommand: overrides.curlCommand ?? defaultConfig.curlCommand,
      encryptionKeyOverride: overrides.encryptionKeyOverride ?? null,
      serviceName: overrides.serviceName ?? defaultConfig.serviceName,
      accountName: overrides.accountName ?? defaultConfig.accountName,
    };
  }

  function createMockDependencies(overrides: Partial<CliDependencies> = {}): CliDependencies {
    const mockSlackService: Service = {
      name: 'slack',
      baseApiUrls: ['https://slack.com/api/'],
      loginUrl: 'https://slack.com/signin',
      loginInstructions: null,
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

  describe('services command', () => {
    it('should list all services as space-separated names', async () => {
      const deps = createMockDependencies();
      await runCommand(['services'], deps);

      expect(logs).toHaveLength(1);
      const services = (logs[0] ?? '').split(' ');
      expect(services).toContain('slack');
    });
  });

  describe('status command', () => {
    it('should return missing when no credentials are stored', async () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(storePath, '{}');

      const deps = createMockDependencies({
        config: createMockConfig({ credentialStorePath: storePath }),
      });

      await runCommand(['status', 'slack'], deps);

      expect(logs).toContain('missing');
    });

    it('should return valid when credentials are valid', async () => {
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

      await runCommand(['status', 'slack'], deps);

      expect(logs).toContain('valid');
    });

    it('should return error for unknown service', async () => {
      const deps = createMockDependencies();

      await runCommand(['status', 'unknown-service'], deps);

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

      await runCommand(['clear', 'slack'], deps);

      expect(logs.some((log) => log.includes('have been cleared'))).toBe(true);
      const storedData = JSON.parse(readFileSync(storePath, 'utf-8')) as StoredCredentials;
      expect(storedData.slack).toBeUndefined();
    });

    it('should report no credentials found when service has no stored credentials', async () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(storePath, '{}');

      const deps = createMockDependencies({
        config: createMockConfig({ credentialStorePath: storePath }),
      });

      await runCommand(['clear', 'slack'], deps);

      expect(logs.some((log) => log.includes('No API credentials found'))).toBe(true);
    });

    it('should return error for unknown service', async () => {
      const storePath = join(tempDir, 'credentials.json');

      const deps = createMockDependencies({
        config: createMockConfig({ credentialStorePath: storePath }),
      });

      await runCommand(['clear', 'unknown-service'], deps);

      expect(exitCode).toBe(1);
      expect(errorLogs.some((log) => log.includes('Unknown service'))).toBe(true);
    });

    it('should use default config paths', async () => {
      const deps = createMockDependencies();

      await runCommand(['clear', 'slack'], deps);

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

      await runCommand(['clear', 'slack'], deps);

      const storedData = JSON.parse(readFileSync(storePath, 'utf-8')) as StoredCredentials;
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
      writeFileSync(browserStatePath, '{}');

      const deps = createMockDependencies({
        config: createMockConfig({ credentialStorePath: storePath, browserStatePath }),
      });

      await runCommand(['clear', '-y'], deps);

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

      await runCommand(['clear', '-y'], deps);

      expect(logs.some((log) => log.includes('No files to delete'))).toBe(true);
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
        baseApiUrls: ['https://slack.com/api/'],
        loginUrl: 'https://slack.com/signin',
        loginInstructions: null,
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

    it('should call login when no credentials in store', async () => {
      const storePath = join(tempDir, 'credentials.json');
      const browserStatePath = join(tempDir, 'browser_state.json');
      writeSecureFile(storePath, '{}');

      const mockLogin = vi
        .fn()
        .mockResolvedValue(new SlackApiCredentials('new-token', 'new-cookie'));
      const mockSlackService: Service = {
        name: 'slack',
        baseApiUrls: ['https://slack.com/api/'],
        loginUrl: 'https://slack.com/signin',
        loginInstructions: null,
        credentialCheckCurlArguments: [],
        checkApiCredentials: vi.fn(),
        getSession: vi.fn().mockReturnValue({ login: mockLogin }),
      };

      const deps = createMockDependencies({
        registry: new Registry([mockSlackService]),
        config: createMockConfig({ credentialStorePath: storePath, browserStatePath }),
      });

      await runCommand(['curl', 'https://slack.com/api/test'], deps);

      expect(mockLogin).toHaveBeenCalledWith(expect.any(BrowserStateStore));
      expect(capturedArgs).toContain('Authorization: Bearer new-token');
    });
  });
});

// Integration tests that run the actual CLI binary
describe.skipIf(!cliPath)('CLI integration tests (subprocess)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'latchkey-cli-test-'));

    delete process.env.LATCHKEY_STORE;
    delete process.env.LATCHKEY_BROWSER_STATE;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('curl command', () => {
    it('should return error when curl has no arguments', () => {
      const result = runCli(['curl']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Could not extract URL');
    });

    it('should return error when no URL found in curl arguments', () => {
      const result = runCli(['curl', '--', '-X', 'POST']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Could not extract URL');
    });

    it('should return error for unknown service', () => {
      const result = runCli(['curl', 'https://unknown-api.example.com']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No service matches URL');
      expect(result.stderr).toContain('https://unknown-api.example.com');
    });
  });

  describe('status command', () => {
    it('should return missing when no LATCHKEY_STORE is set', () => {
      const result = runCli(['status', 'slack'], {});
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('missing');
    });

    it('should return missing when no credentials are stored', () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(storePath, '{}');

      const result = runCli(['status', 'slack'], { LATCHKEY_STORE: storePath });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('missing');
    });

    it('should return error for unknown service', () => {
      const result = runCli(['status', 'unknown-service']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown service');
    });
  });

  describe('clear command', () => {
    it('should delete credentials for a service', () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(
        storePath,
        JSON.stringify({
          slack: { objectType: 'slack', token: 'test-token', dCookie: 'test-cookie' },
        })
      );

      const result = runCli(['clear', 'slack'], { LATCHKEY_STORE: storePath });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('API credentials for slack have been cleared');

      const storedData = JSON.parse(readFileSync(storePath, 'utf-8')) as StoredCredentials;
      expect(storedData.slack).toBeUndefined();
    });

    it('should report no credentials found when service has no stored credentials', () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(storePath, '{}');

      const result = runCli(['clear', 'slack'], { LATCHKEY_STORE: storePath });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No API credentials found for slack');
    });

    it('should return error for unknown service', () => {
      const storePath = join(tempDir, 'credentials.json');
      const result = runCli(['clear', 'unknown-service'], { LATCHKEY_STORE: storePath });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown service: unknown-service');
    });

    it('should preserve other services when clearing one', () => {
      const storePath = join(tempDir, 'credentials.json');
      writeSecureFile(
        storePath,
        JSON.stringify({
          slack: { objectType: 'slack', token: 'slack-token', dCookie: 'slack-cookie' },
          discord: { objectType: 'authorizationBare', token: 'discord-token' },
        })
      );

      const result = runCli(['clear', 'slack'], { LATCHKEY_STORE: storePath });
      expect(result.exitCode).toBe(0);

      const storedData = JSON.parse(readFileSync(storePath, 'utf-8')) as StoredCredentials;
      expect(storedData.slack).toBeUndefined();
      expect(storedData.discord).toBeDefined();
      expect(storedData.discord?.token).toBe('discord-token');
    });

    it('should delete both store and browser state with -y flag', () => {
      const storePath = join(tempDir, 'credentials.json');
      const browserStatePath = join(tempDir, 'browser_state.json');
      writeSecureFile(
        storePath,
        JSON.stringify({ slack: { objectType: 'slack', token: 'test', dCookie: 'test' } })
      );
      writeFileSync(browserStatePath, '{}');

      const result = runCli(['clear', '-y'], {
        LATCHKEY_STORE: storePath,
        LATCHKEY_BROWSER_STATE: browserStatePath,
      });
      expect(result.exitCode).toBe(0);
      expect(existsSync(storePath)).toBe(false);
      expect(existsSync(browserStatePath)).toBe(false);
      expect(result.stdout).toContain(`Deleted credentials store: ${storePath}`);
      expect(result.stdout).toContain(`Deleted browser state: ${browserStatePath}`);
    });

    it('should delete only existing files with -y flag', () => {
      const storePath = join(tempDir, 'credentials.json');
      const browserStatePath = join(tempDir, 'browser_state.json');
      writeSecureFile(storePath, '{}');
      // browser_state does not exist

      const result = runCli(['clear', '-y'], {
        LATCHKEY_STORE: storePath,
        LATCHKEY_BROWSER_STATE: browserStatePath,
      });
      expect(result.exitCode).toBe(0);
      expect(existsSync(storePath)).toBe(false);
      expect(result.stdout).toContain(`Deleted credentials store: ${storePath}`);
      expect(result.stdout).not.toContain('browser state');
    });

    it('should report no files to delete when none exist', () => {
      const storePath = join(tempDir, 'nonexistent_store.json');
      const browserStatePath = join(tempDir, 'nonexistent_browser_state.json');

      const result = runCli(['clear', '-y'], {
        LATCHKEY_STORE: storePath,
        LATCHKEY_BROWSER_STATE: browserStatePath,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No files to delete');
    });

    it('should work with no env vars when clearing all', () => {
      const result = runCli(['clear', '-y'], {});
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No files to delete');
    });
  });

  describe('services command', () => {
    it('should list all services as space-separated names', () => {
      const result = runCli(['services']);
      expect(result.exitCode).toBe(0);

      const services = result.stdout.trim().split(' ');
      expect(services).toContain('slack');
      expect(services).toContain('discord');
      expect(services).toContain('github');
      expect(services).toContain('dropbox');
      expect(services).toContain('linear');
    });
  });
});
