import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_ENCRYPTION_KEY = 'dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleXRlc3Q=';

const projectRoot = join(__dirname, '..');
const shimPath = join(projectRoot, 'scripts', 'latchkey');
const projectVersion = (
  JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8')) as { version: string }
).version;

// Minimal PATH for hermetic resolution checks: node's own directory plus the
// system tools (bash, git, grep, ...) the scripts need.
const minimalSystemPath = [dirname(process.execPath), '/usr/bin', '/bin'].join(':');

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

function createFakeLatchkeyCheckout(directory: string, options: { includeTsx: boolean }): void {
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify({ name: 'latchkey' })}\n`);
  mkdirSync(join(directory, 'src'));
  if (options.includeTsx) {
    // Borrow this repo's node_modules so the fake checkout has a working tsx.
    symlinkSync(join(projectRoot, 'node_modules'), join(directory, 'node_modules'));
  } else {
    mkdirSync(join(directory, 'node_modules'));
  }
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

  it('runs the real CLI from source in the checkout containing cwd', () => {
    const result = runShim(['--version'], {
      cwd: projectRoot,
      env: { LATCHKEY_DIRECTORY: latchkeyDirectory },
    });

    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(projectVersion);
  });

  it('reflects source edits in the cwd checkout without a build', () => {
    const fakeCheckout = join(tempDir, 'fake-checkout');
    mkdirSync(fakeCheckout);
    createFakeLatchkeyCheckout(fakeCheckout, { includeTsx: true });

    const firstRun = runShim([], { cwd: fakeCheckout });
    expect(firstRun.exitCode).toBe(0);
    expect(firstRun.stdout.trim()).toBe('fake-cli source v1');

    writeFileSync(join(fakeCheckout, 'src', 'cli.ts'), "console.log('fake-cli source v2');\n");

    const secondRun = runShim([], { cwd: fakeCheckout });
    expect(secondRun.exitCode).toBe(0);
    expect(secondRun.stdout.trim()).toBe('fake-cli source v2');
  });

  it('fails with an install instruction when src/version.ts is missing', () => {
    const fakeCheckout = join(tempDir, 'fake-checkout');
    mkdirSync(fakeCheckout);
    createFakeLatchkeyCheckout(fakeCheckout, { includeTsx: true });
    rmSync(join(fakeCheckout, 'src', 'version.ts'));

    const result = runShim([], { cwd: fakeCheckout });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('version.ts');
    expect(result.stderr).toContain('npm install');
  });

  it('falls back to its own checkout when cwd is outside any checkout', () => {
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
  });

  it('ignores enclosing git repositories that are not latchkey', () => {
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

  it('fails with an install instruction when the checkout has no tsx', () => {
    const fakeCheckout = join(tempDir, 'fake-checkout');
    mkdirSync(fakeCheckout);
    createFakeLatchkeyCheckout(fakeCheckout, { includeTsx: false });

    const result = runShim([], { cwd: fakeCheckout });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('tsx');
    expect(result.stderr).toContain('npm install');
  });

  it('fails when neither cwd nor the shim location is inside a latchkey checkout', () => {
    // A copy (not a symlink) severs the shim from its checkout, like a stray
    // install outside any clone.
    const copiedShim = join(tempDir, 'latchkey');
    copyFileSync(shimPath, copiedShim);
    chmodSync(copiedShim, 0o755);

    const result = runShim(['--version'], { cwd: tempDir, command: copiedShim });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not inside a latchkey checkout');
  });

  it('fails with an install instruction when the checkout has no node_modules', () => {
    const fakeCheckout = join(tempDir, 'fake-checkout');
    mkdirSync(fakeCheckout);
    createFakeLatchkeyCheckout(fakeCheckout, { includeTsx: false });
    rmSync(join(fakeCheckout, 'node_modules'), { recursive: true });

    const result = runShim([], { cwd: fakeCheckout });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('npm install');
  });

  describe('installer (scripts/installDevShim.sh)', () => {
    const installerPath = join(projectRoot, 'scripts', 'installDevShim.sh');

    function runInstaller(pathValue: string, home: string): ShimResult {
      return runShim([], {
        cwd: projectRoot,
        command: installerPath,
        env: { HOME: home, PATH: pathValue },
      });
    }

    it('symlinks the shim into ~/.local/bin and confirms it wins on PATH', () => {
      const fakeHome = join(tempDir, 'fake-home');
      mkdirSync(fakeHome);
      const binDirectory = join(fakeHome, '.local', 'bin');

      const result = runInstaller([binDirectory, minimalSystemPath].join(':'), fakeHome);

      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('installed latchkey dev shim');
      expect(readlinkSync(join(binDirectory, 'latchkey'))).toBe(shimPath);
    });

    it('warns when something else on PATH shadows the shim', () => {
      const fakeHome = join(tempDir, 'fake-home');
      mkdirSync(fakeHome);
      const shadowDirectory = join(tempDir, 'shadow-bin');
      mkdirSync(shadowDirectory);
      writeFileSync(
        join(shadowDirectory, 'latchkey'),
        "#!/usr/bin/env bash\necho 'stale global'\n"
      );
      chmodSync(join(shadowDirectory, 'latchkey'), 0o755);

      const result = runInstaller(
        [shadowDirectory, join(fakeHome, '.local', 'bin'), minimalSystemPath].join(':'),
        fakeHome
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('instead of the dev shim');
      expect(readlinkSync(join(fakeHome, '.local', 'bin', 'latchkey'))).toBe(shimPath);
    });
  });

  describe('uninstaller (scripts/uninstallDevShim.sh)', () => {
    const uninstallerPath = join(projectRoot, 'scripts', 'uninstallDevShim.sh');

    function runUninstaller(home: string): ShimResult {
      return runShim([], {
        cwd: projectRoot,
        command: uninstallerPath,
        env: { HOME: home, PATH: minimalSystemPath },
      });
    }

    // lstat, not exists: a dangling symlink is still a path we must clean up.
    function pathExists(path: string): boolean {
      try {
        lstatSync(path);
        return true;
      } catch {
        return false;
      }
    }

    function createFakeHomeWithBinDirectory(): { home: string; binDirectory: string } {
      const home = join(tempDir, 'fake-home');
      const binDirectory = join(home, '.local', 'bin');
      mkdirSync(binDirectory, { recursive: true });
      return { home, binDirectory };
    }

    it('removes the installed shim symlink', () => {
      const { home, binDirectory } = createFakeHomeWithBinDirectory();
      const linkPath = join(binDirectory, 'latchkey');
      symlinkSync(shimPath, linkPath);

      const result = runUninstaller(home);

      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('removed latchkey dev shim');
      expect(pathExists(linkPath)).toBe(false);
    });

    it('succeeds when no shim is installed', () => {
      const { home } = createFakeHomeWithBinDirectory();

      const result = runUninstaller(home);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('nothing to do');
    });

    it('removes a dangling shim symlink whose checkout is gone', () => {
      const { home, binDirectory } = createFakeHomeWithBinDirectory();
      const linkPath = join(binDirectory, 'latchkey');
      symlinkSync(join(tempDir, 'deleted-checkout', 'scripts', 'latchkey'), linkPath);

      const result = runUninstaller(home);

      expect(result.exitCode).toBe(0);
      expect(pathExists(linkPath)).toBe(false);
    });

    it('refuses to remove a latchkey that is not the dev shim', () => {
      const { home, binDirectory } = createFakeHomeWithBinDirectory();
      const linkPath = join(binDirectory, 'latchkey');
      writeFileSync(linkPath, "#!/usr/bin/env bash\necho 'some other install'\n");
      chmodSync(linkPath, 0o755);

      const result = runUninstaller(home);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not a latchkey dev shim');
      expect(pathExists(linkPath)).toBe(true);
    });
  });
});
