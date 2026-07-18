import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_ENCRYPTION_KEY = 'dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleXRlc3Q=';

const projectRoot = join(__dirname, '..');
const shimPath = join(projectRoot, 'scripts', 'latchkey');
const projectVersion = (
  JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8')) as { version: string }
).version;

// PATH with no bun on it: just node's own directory plus the system tools
// (bash, git, grep, ...) the shim needs.
const pathWithoutBun = [dirname(process.execPath), '/usr/bin', '/bin'].join(':');

function isBunAvailable(): boolean {
  try {
    execFileSync('bun', ['--version'], { stdio: 'pipe' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

const bunAvailable = isBunAvailable();

interface ShimResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ExecError {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runShim(
  args: string[],
  options: { cwd: string; env?: Record<string, string>; command?: string }
): ShimResult {
  try {
    const stdout = execFileSync(options.command ?? shimPath, args, {
      cwd: options.cwd,
      encoding: 'utf-8',
      env: {
        ...process.env,
        LATCHKEY_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
        LATCHKEY_DISABLE_COUNTING: '1',
        ...options.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error) {
    const execError = error as ExecError;
    return {
      exitCode: execError.status ?? 1,
      stdout: execError.stdout,
      stderr: execError.stderr,
    };
  }
}

function createFakeLatchkeyCheckout(directory: string): void {
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify({ name: 'latchkey' })}\n`);
  mkdirSync(join(directory, 'src'));
  mkdirSync(join(directory, 'node_modules'));
  writeFileSync(join(directory, 'src', 'cli.ts'), "console.log('fake-cli source v1');\n");
  writeFileSync(join(directory, 'src', 'version.ts'), "export const VERSION = '0.0.0-fake';\n");
}

describe('dev shim (scripts/latchkey)', () => {
  let tempDir: string;
  let latchkeyDirectory: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'latchkey-dev-shim-test-'));
    latchkeyDirectory = join(tempDir, 'latchkey-home');
    mkdirSync(latchkeyDirectory);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it.skipIf(!bunAvailable)('runs the real CLI from source in the checkout containing cwd', () => {
    const result = runShim(['--version'], {
      cwd: projectRoot,
      env: { LATCHKEY_DIRECTORY: latchkeyDirectory },
    });

    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(projectVersion);
  });

  it.skipIf(!bunAvailable)('reflects source edits in the cwd checkout without a build', () => {
    const fakeCheckout = join(tempDir, 'fake-checkout');
    mkdirSync(fakeCheckout);
    createFakeLatchkeyCheckout(fakeCheckout);

    const firstRun = runShim([], { cwd: fakeCheckout });
    expect(firstRun.exitCode).toBe(0);
    expect(firstRun.stdout.trim()).toBe('fake-cli source v1');

    writeFileSync(join(fakeCheckout, 'src', 'cli.ts'), "console.log('fake-cli source v2');\n");

    const secondRun = runShim([], { cwd: fakeCheckout });
    expect(secondRun.exitCode).toBe(0);
    expect(secondRun.stdout.trim()).toBe('fake-cli source v2');
  });

  it.skipIf(!bunAvailable)(
    'falls back to its own checkout when cwd is outside any checkout',
    () => {
      // Invoke through a symlink, like the ~/.local/bin install, so the shim has
      // to resolve its real location before discovering its checkout.
      const symlinkedShim = join(tempDir, 'latchkey');
      symlinkSync(shimPath, symlinkedShim);

      const result = runShim(['--version'], {
        cwd: tempDir,
        env: { LATCHKEY_DIRECTORY: latchkeyDirectory },
        command: symlinkedShim,
      });

      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(projectVersion);
    }
  );

  it.skipIf(!bunAvailable)('ignores enclosing git repositories that are not latchkey', () => {
    const unrelatedRepository = join(tempDir, 'unrelated');
    mkdirSync(unrelatedRepository);
    execFileSync('git', ['init', '--quiet'], { cwd: unrelatedRepository });

    const result = runShim(['--version'], {
      cwd: unrelatedRepository,
      env: { LATCHKEY_DIRECTORY: latchkeyDirectory },
    });

    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(projectVersion);
  });

  it('runs the built output under node when bun is not on PATH', () => {
    const fakeCheckout = join(tempDir, 'fake-checkout');
    mkdirSync(fakeCheckout);
    createFakeLatchkeyCheckout(fakeCheckout);
    mkdirSync(join(fakeCheckout, 'dist', 'src'), { recursive: true });
    writeFileSync(
      join(fakeCheckout, 'dist', 'src', 'cli.js'),
      "console.log('fake-cli dist build');\n"
    );

    const result = runShim([], { cwd: fakeCheckout, env: { PATH: pathWithoutBun } });

    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('fake-cli dist build');
  });

  it('runs the built output when LATCHKEY_DEV_SHIM_USE_DIST is set', () => {
    const fakeCheckout = join(tempDir, 'fake-checkout');
    mkdirSync(fakeCheckout);
    createFakeLatchkeyCheckout(fakeCheckout);
    mkdirSync(join(fakeCheckout, 'dist', 'src'), { recursive: true });
    writeFileSync(
      join(fakeCheckout, 'dist', 'src', 'cli.js'),
      "console.log('fake-cli dist build');\n"
    );

    const result = runShim([], { cwd: fakeCheckout, env: { LATCHKEY_DEV_SHIM_USE_DIST: '1' } });

    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('fake-cli dist build');
  });

  it('fails with a build instruction when bun is not on PATH and dist is missing', () => {
    const fakeCheckout = join(tempDir, 'fake-checkout');
    mkdirSync(fakeCheckout);
    createFakeLatchkeyCheckout(fakeCheckout);

    const result = runShim([], { cwd: fakeCheckout, env: { PATH: pathWithoutBun } });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('npm run build');
  });

  it('fails with an install instruction when the checkout has no node_modules', () => {
    const fakeCheckout = join(tempDir, 'fake-checkout');
    mkdirSync(fakeCheckout);
    createFakeLatchkeyCheckout(fakeCheckout);
    rmSync(join(fakeCheckout, 'node_modules'), { recursive: true });

    const result = runShim([], { cwd: fakeCheckout });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('npm install');
  });
});
