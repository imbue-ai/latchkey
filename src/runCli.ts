/**
 * Run a `latchkey` command inside the current process instead of spawning
 * the executable.
 */

import { spawnSync } from 'node:child_process';
import { Command, CommanderError } from 'commander';
import { createDefaultDependencies, createProgram, type CliDependencies } from './cliCommands.js';
import { type LatchkeyEnvironment, configFromEnvironment, runWithConfig } from './config.js';
import { describeStartupError, runStartupTasks } from './startup.js';

export interface RunCliOptions {
  /** What the command reads as its standard input. Defaults to nothing. */
  readonly stdin?: string;
  /** Answers the command's confirmation prompts. Defaults to declining. */
  readonly confirm?: (message: string) => Promise<boolean>;
  /**
   * Where the `LATCHKEY_*` variables are taken from, instead of `process.env`
   * (and `LATCHKEY_ENV_OVERRIDES_FD`): one that is set there but not here
   * counts as unset. Everything else, such as `PATH` and the environment curl
   * is spawned with, stays that of the process. Read once per call.
   */
  readonly env?: LatchkeyEnvironment;
}

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

class CliExit extends Error {
  constructor(readonly exitCode: number) {
    super(`latchkey exited with code ${String(exitCode)}`);
    this.name = 'CliExit';
  }
}

/**
 * Run `latchkey <args>` and resolve to what the executable would have
 * printed and exited with. Configured by the environment, like the
 * executable. Errors the executable would crash on are thrown.
 *
 * `latchkey curl` blocks the event loop until curl finishes.
 */
export function runCli(args: readonly string[], options: RunCliOptions = {}): Promise<CliResult> {
  return runWithConfig(configFromEnvironment(options.env), () =>
    runCliWithCurrentConfig(args, options)
  );
}

async function runCliWithCurrentConfig(
  args: readonly string[],
  options: RunCliOptions
): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdin = options.stdin ?? '';
  const resultWith = (exitCode: number): CliResult => ({
    exitCode,
    stdout: stdout.join(''),
    stderr: stderr.join(''),
  });

  try {
    const defaultDependencies = await createDefaultDependencies();
    await runStartupTasks(defaultDependencies.config);
    const deps: CliDependencies = {
      ...defaultDependencies,
      runCurl: (curlArguments) => {
        const result = spawnSync(defaultDependencies.config.curlCommand, [...curlArguments], {
          input: stdin,
          encoding: 'utf-8',
          maxBuffer: Infinity,
        });
        stdout.push(result.stdout);
        stderr.push(result.stderr);
        return { returncode: result.status ?? 1, stdout: '', stderr: '' };
      },
      confirm: options.confirm ?? (() => Promise.resolve(false)),
      readStdin: () => Promise.resolve(stdin),
      exit: (code) => {
        throw new CliExit(code);
      },
      log: (message) => stdout.push(`${message}\n`),
      errorLog: (message) => stderr.push(`${message}\n`),
    };
    const program = createProgram(
      deps,
      new Command().exitOverride().configureOutput({
        writeOut: (text) => stdout.push(text),
        writeErr: (text) => stderr.push(text),
      })
    );
    await program.parseAsync([...args], { from: 'user' });
    return resultWith(0);
  } catch (error) {
    if (error instanceof CliExit || error instanceof CommanderError) {
      return resultWith(error.exitCode);
    }
    const startupMessage = describeStartupError(error);
    if (startupMessage !== null) {
      stderr.push(`${startupMessage}\n`);
      return resultWith(1);
    }
    throw error;
  }
}
