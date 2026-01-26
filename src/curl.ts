/**
 * Curl subprocess utilities.
 */

import { spawnSync, SpawnSyncReturns } from 'node:child_process';

export interface CurlResult {
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Type for the subprocess runner function (no output capture, for interactive use).
 */
export type SubprocessRunner = (args: readonly string[]) => CurlResult;

/**
 * Type for the capturing subprocess runner function (captures output).
 */
export type CapturingSubprocessRunner = (args: readonly string[], timeout: number) => CurlResult;

function defaultSubprocessRunner(args: readonly string[]): CurlResult {
  const result: SpawnSyncReturns<Buffer> = spawnSync('curl', args as string[], {
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  return {
    returncode: result.status ?? 1,
    stdout: '',
    stderr: '',
  };
}

function defaultCapturingSubprocessRunner(args: readonly string[], timeout: number): CurlResult {
  const result: SpawnSyncReturns<string> = spawnSync('curl', args as string[], {
    encoding: 'utf-8',
    timeout: timeout * 1000,
  });
  return {
    returncode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

let subprocessRunner: SubprocessRunner = defaultSubprocessRunner;
let capturingSubprocessRunner: CapturingSubprocessRunner = defaultCapturingSubprocessRunner;

export function setSubprocessRunner(runner: SubprocessRunner): void {
  subprocessRunner = runner;
}

export function resetSubprocessRunner(): void {
  subprocessRunner = defaultSubprocessRunner;
}

export function setCapturingSubprocessRunner(runner: CapturingSubprocessRunner): void {
  capturingSubprocessRunner = runner;
}

export function resetCapturingSubprocessRunner(): void {
  capturingSubprocessRunner = defaultCapturingSubprocessRunner;
}

/**
 * Run curl without capturing output (for interactive CLI use).
 */
export function run(args: readonly string[]): CurlResult {
  return subprocessRunner(args);
}

/**
 * Run curl with output capture (for credential checking).
 */
export function runCaptured(args: readonly string[], timeout: number = 10): CurlResult {
  return capturingSubprocessRunner(args, timeout);
}
