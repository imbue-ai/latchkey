import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');

interface ImportReport {
  readonly isImported: boolean;
  readonly exportedNames: readonly string[];
  readonly errorName: string | null;
  readonly descriptorVariable: string | null;
}

describe('importing an entry point', () => {
  let temporaryDirectory: string;
  let homeDirectory: string;
  let latchkeyDirectory: string;

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'latchkey-embed-import-'));
    homeDirectory = join(temporaryDirectory, 'home');
    mkdirSync(homeDirectory);
    latchkeyDirectory = join(temporaryDirectory, 'does-not-exist');
  });

  afterEach(() => {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  /**
   * Import a module of the source tree in a process of its own, whose
   * environment would make any read of Latchkey's variables fail or leave a
   * trace: a descriptor variable that is not a number, a Latchkey directory
   * that does not exist, and an empty home directory.
   */
  function importInChildProcess(modulePath: string): ImportReport {
    const script = [
      'const report = { isImported: false, exportedNames: [], errorName: null };',
      'try {',
      `  const imported = await import(${JSON.stringify(modulePath)});`,
      '  report.isImported = true;',
      '  report.exportedNames = Object.keys(imported);',
      '} catch (error) {',
      '  report.errorName = error.name;',
      '}',
      'report.descriptorVariable = process.env.LATCHKEY_ENV_OVERRIDES_FD ?? null;',
      'console.log(JSON.stringify(report));',
    ].join('\n');
    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          LATCHKEY_ENV_OVERRIDES_FD: 'not-a-number',
          LATCHKEY_DIRECTORY: latchkeyDirectory,
          HOME: homeDirectory,
          USERPROFILE: homeDirectory,
        },
        stdio: ['ignore', 'pipe', 'inherit'],
        encoding: 'utf-8',
      }
    );
    return JSON.parse(output) as ImportReport;
  }

  it('reads no environment and creates nothing when the entry is latchkey/embed', () => {
    const report = importInChildProcess('./src/embed.ts');

    expect(report.errorName).toBeNull();
    expect(report.isImported).toBe(true);
    expect(report.exportedNames).toContain('createLatchkeyRuntime');
    expect(report.exportedNames).toContain('createGatewayRequestHandler');
    // Reading any of Latchkey's variables consumes the descriptor variable.
    expect(report.descriptorVariable).toBe('not-a-number');
    expect(readdirSync(homeDirectory)).toEqual([]);
    expect(existsSync(latchkeyDirectory)).toBe(false);
  }, 60_000);

  // The main entry point itself cannot be imported from source by tsx, which
  // does not drop its re-exported interfaces; tests/embedConsumer.test.ts
  // imports the built one. This is the module the main entry point gets its
  // read of the environment from.
  it('fails under the same environment when the module holds the command line configuration', () => {
    const report = importInChildProcess('./src/globalConfig.ts');

    expect(report.isImported).toBe(false);
    expect(report.errorName).toBe('InvalidEnvironmentOverridesError');
    expect(report.descriptorVariable).toBeNull();
  }, 60_000);
});
