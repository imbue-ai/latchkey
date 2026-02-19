/**
 * Curl subprocess utilities.
 */

import { spawnSync, SpawnSyncReturns } from 'node:child_process';
import { CONFIG } from './config.js';

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
  const result: SpawnSyncReturns<Buffer> = spawnSync(CONFIG.curlCommand, args as string[], {
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  return {
    returncode: result.status ?? 1,
    stdout: '',
    stderr: '',
  };
}

function defaultCapturingSubprocessRunner(args: readonly string[], timeout: number): CurlResult {
  const result: SpawnSyncReturns<string> = spawnSync(CONFIG.curlCommand, args as string[], {
    encoding: 'utf-8',
    timeout: timeout * 1000,
  });
  return {
    returncode: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
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
export function runCaptured(args: readonly string[], timeout = 10): CurlResult {
  return capturingSubprocessRunner(args, timeout);
}

// Curl flags that don't affect the HTTP request semantics but may not be supported by URL extraction.
const CURL_PASSTHROUGH_FLAGS = new Set(['-v', '--verbose']);

function filterPassthroughFlags(args: string[]): string[] {
  return args.filter((arg) => !CURL_PASSTHROUGH_FLAGS.has(arg));
}

export function extractUrlFromCurlArguments(args: string[]): string | null {
  const filteredArgs = filterPassthroughFlags(args);

  // Simple URL extraction: look for arguments that look like URLs
  // or parse known curl argument patterns
  for (let i = 0; i < filteredArgs.length; i++) {
    const arg = filteredArgs[i];
    if (arg === undefined) continue;

    // Skip flags and their values
    if (arg.startsWith('-')) {
      // Skip flags that take a value
      if (['-H', '-d', '-X', '-o', '-w', '-u', '-A', '-e', '-b', '-c', '-F', '-T'].includes(arg)) {
        i++; // Skip the next argument which is the value
      }
      continue;
    }

    // This looks like a URL
    if (arg.startsWith('http://') || arg.startsWith('https://')) {
      return arg;
    }
  }

  return null;
}
