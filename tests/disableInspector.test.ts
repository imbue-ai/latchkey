import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_ENCRYPTION_KEY = 'dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleXRlc3Q=';

const projectRoot = join(__dirname, '..');

function waitFor(predicate: () => boolean, timeoutMilliseconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
      } else if (Date.now() - startedAt > timeoutMilliseconds) {
        reject(new Error('timed out waiting for condition'));
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}

describe.skipIf(process.platform === 'win32')('inspector activation via SIGUSR1', () => {
  let tempDir: string;
  let child: ChildProcess | null = null;

  afterEach(() => {
    child?.kill('SIGKILL');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('is disabled for the running CLI', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'latchkey-inspector-test-'));
    let output = '';
    child = spawn(
      process.execPath,
      ['--import', 'tsx', join(projectRoot, 'src', 'cli.ts'), 'gateway', '--port', '0'],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          LATCHKEY_DIRECTORY: tempDir,
          LATCHKEY_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
          LATCHKEY_DISABLE_COUNTING: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    child.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });

    await waitFor(() => output.includes('listening on'), 30_000);

    child.kill('SIGUSR1');
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    expect(output).not.toContain('Debugger listening');
    expect(output).not.toContain('nodejs.org/en/docs/inspector');
    // The signal must neither open the inspector nor terminate the process.
    expect(exitCode).toBeNull();
    expect(exitSignal).toBeNull();
  }, 60_000);
});
