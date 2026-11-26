import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { runCli as runCliType } from '../src/index.js';

describe('runCli', () => {
  let directory: string;
  let runCli: typeof runCliType;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'latchkey-run-cli-test-'));
    vi.stubEnv('LATCHKEY_DIRECTORY', directory);
    vi.stubEnv('LATCHKEY_ENCRYPTION_KEY', 'dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleXRlc3Q=');
    vi.stubEnv('LATCHKEY_DISABLE_COUNTING', '1');
    vi.stubEnv('LATCHKEY_GATEWAY', '');
    // The configuration is read from the environment when the module loads.
    vi.resetModules();
    ({ runCli } = await import('../src/index.js'));
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it('stores credentials that a later call sees', async () => {
    const set = await runCli(['auth', 'set', 'slack', '-H', 'Authorization: Bearer test-token']);
    expect(set).toEqual({ exitCode: 0, stdout: 'Credentials stored.\n', stderr: '' });

    const list = await runCli(['auth', 'list']);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain('slack');
  });

  it('sees a service registered by an earlier call', async () => {
    const register = await runCli([
      'services',
      'register',
      'my-service',
      '--base-api-url=https://my-service.example.com/api/',
    ]);
    expect(register.exitCode).toBe(0);

    const info = await runCli(['services', 'info', 'my-service', '--offline']);
    expect(info.exitCode).toBe(0);
  });

  it('reports a failing command through the exit code and stderr', async () => {
    const result = await runCli(['auth', 'set', 'no-such-service', '-H', 'X: y']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Unknown service: no-such-service');
  });

  it('captures the output of commander itself', async () => {
    const help = await runCli(['auth', '--help']);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('Manage authentication credentials.');

    const unknown = await runCli(['auth', 'list', '--no-such-option']);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain('--no-such-option');

    const version = await runCli(['--version']);
    expect(version.exitCode).toBe(0);
    expect(version.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('declines confirmation prompts unless told otherwise', async () => {
    const declined = await runCli(['auth', 'clear']);
    const listAfterDeclining = await runCli(['auth', 'list']);
    expect(listAfterDeclining.stdout).toContain('slack');

    const confirmed = await runCli(['auth', 'clear'], { confirm: () => Promise.resolve(true) });
    expect(confirmed.exitCode).toBe(0);
    const listAfterConfirming = await runCli(['auth', 'list']);
    expect(listAfterConfirming.stdout).not.toContain('slack');
    expect(declined.stdout).not.toEqual(confirmed.stdout);
  });
});
