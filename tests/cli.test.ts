import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, ExecSyncOptionsWithStringEncoding } from 'node:child_process';
import { extractUrlFromCurlArguments } from '../src/cli.js';

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
  slack?: { object_type: string; token: string; d_cookie: string };
  discord?: { object_type: string; token: string };
  [key: string]: unknown;
}

function runCli(args: string[], env: Record<string, string> = {}): CliResult {
  const options: ExecSyncOptionsWithStringEncoding = {
    cwd: join(__dirname, '..'),
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  };

  try {
    const stdout = execSync(`node dist/src/cli.js ${args.join(' ')}`, options);
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
});

describe('CLI curl command', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'latchkey-cli-test-'));

    // Clear LATCHKEY_* env vars
    delete process.env.LATCHKEY_STORE;
    delete process.env.LATCHKEY_BROWSER_STATE;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

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

describe('CLI status command', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'latchkey-cli-test-'));

    // Clear LATCHKEY_* env vars
    delete process.env.LATCHKEY_STORE;
    delete process.env.LATCHKEY_BROWSER_STATE;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return missing when no LATCHKEY_STORE is set', () => {
    const result = runCli(['status', 'slack'], {});
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('missing');
  });

  it('should return missing when no credentials are stored', () => {
    const storePath = join(tempDir, 'credentials.json');
    writeFileSync(storePath, '{}');

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

describe('CLI clear command', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'latchkey-cli-test-'));

    // Clear LATCHKEY_* env vars
    delete process.env.LATCHKEY_STORE;
    delete process.env.LATCHKEY_BROWSER_STATE;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should delete credentials for a service', () => {
    const storePath = join(tempDir, 'credentials.json');
    writeFileSync(
      storePath,
      JSON.stringify({
        slack: { object_type: 'slack', token: 'test-token', d_cookie: 'test-cookie' },
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
    writeFileSync(storePath, '{}');

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

  it('should return error when LATCHKEY_STORE is not set', () => {
    const result = runCli(['clear', 'slack'], {});
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('LATCHKEY_STORE environment variable is not set');
  });

  it('should preserve other services when clearing one', () => {
    const storePath = join(tempDir, 'credentials.json');
    writeFileSync(
      storePath,
      JSON.stringify({
        slack: { object_type: 'slack', token: 'slack-token', d_cookie: 'slack-cookie' },
        discord: { object_type: 'authorization_bare', token: 'discord-token' },
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
    writeFileSync(
      storePath,
      JSON.stringify({ slack: { object_type: 'slack', token: 'test', d_cookie: 'test' } })
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
    writeFileSync(storePath, '{}');
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

describe('CLI services command', () => {
  it('should list all services as JSON', () => {
    const result = runCli(['services']);
    expect(result.exitCode).toBe(0);

    const services = JSON.parse(result.stdout.trim()) as string[];
    expect(services).toContain('slack');
    expect(services).toContain('discord');
    expect(services).toContain('github');
    expect(services).toContain('dropbox');
    expect(services).toContain('linear');
  });
});
