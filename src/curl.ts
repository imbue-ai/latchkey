/**
 * Curl subprocess utilities.
 */

import { spawn, spawnSync, SpawnSyncReturns } from 'node:child_process';
import { CurlParseError, parseCurlArgs } from '@imbue-ai/detent';
import { CONFIG } from './config.js';

// Re-export detent's curl-parsing primitives so the rest of the codebase can
// treat `./curl.js` as the single entry point for curl parsing and doesn't
// have to depend on detent directly.
export { CurlParseError, parseCurlArgs };

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

/**
 * Type for the detached subprocess runner function (fire-and-forget, no waiting).
 */
export type DetachedSubprocessRunner = (args: readonly string[]) => void;

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

function defaultDetachedSubprocessRunner(args: readonly string[]): void {
  const child = spawn(CONFIG.curlCommand, args as string[], {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
}

let subprocessRunner: SubprocessRunner = defaultSubprocessRunner;
let capturingSubprocessRunner: CapturingSubprocessRunner = defaultCapturingSubprocessRunner;
/**
 * Result from an async curl execution that captures output as buffers.
 */
export interface AsyncCurlResult {
  readonly returncode: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

/**
 * Type for the async subprocess runner function (captures output, non-blocking).
 */
export type AsyncSubprocessRunner = (
  args: readonly string[],
  options?: { stdin?: Buffer }
) => Promise<AsyncCurlResult>;

function defaultAsyncSubprocessRunner(
  args: readonly string[],
  options?: { stdin?: Buffer }
): Promise<AsyncCurlResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(CONFIG.curlCommand, args as string[], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: string[] = [];

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });

    child.on('error', reject);

    child.on('close', (code) => {
      resolve({
        returncode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks),
        stderr: stderrChunks.join(''),
      });
    });

    if (options?.stdin !== undefined) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

let detachedSubprocessRunner: DetachedSubprocessRunner = defaultDetachedSubprocessRunner;
let asyncSubprocessRunner: AsyncSubprocessRunner = defaultAsyncSubprocessRunner;

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

export function setDetachedSubprocessRunner(runner: DetachedSubprocessRunner): void {
  detachedSubprocessRunner = runner;
}

export function resetDetachedSubprocessRunner(): void {
  detachedSubprocessRunner = defaultDetachedSubprocessRunner;
}

export function setAsyncSubprocessRunner(runner: AsyncSubprocessRunner): void {
  asyncSubprocessRunner = runner;
}

export function resetAsyncSubprocessRunner(): void {
  asyncSubprocessRunner = defaultAsyncSubprocessRunner;
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

/**
 * Spawn a detached curl process without waiting for it to complete.
 * The parent process can exit before the curl process finishes.
 */
export function runDetached(args: readonly string[]): void {
  detachedSubprocessRunner(args);
}

/**
 * Run curl asynchronously with output capture (for gateway proxy use).
 */
export function runAsync(
  args: readonly string[],
  options?: { stdin?: Buffer }
): Promise<AsyncCurlResult> {
  return asyncSubprocessRunner(args, options);
}

/**
 * Extract the target URL argument from a curl invocation.
 *
 * Delegates curl flag parsing to `parseCurlArgs` from detent (which knows the
 * full curl flag vocabulary) to determine the canonical request URL, and then
 * returns the original, unnormalized argument string so callers can use it for
 * positional substitution (gateway rewriting, Telegram URL rewriting, ...).
 *
 * Schemeless URLs (e.g. `www.example.com`) are supported: curl defaults them
 * to `http://`, and we do the same when normalizing for the comparison.
 * Only http(s) URLs are recognized; other schemes (ftp, file, ...) return
 * null.
 *
 * Matching happens in two passes: first we look for an argv token that fully
 * matches the parsed URL (including query string). If none is found we fall
 * back to matching with the query string and fragment stripped from both
 * sides, which handles `-G` combined with `--data-urlencode`/`-d`/`--data`
 * (where detent folds the data into the parsed URL but argv still carries
 * just the bare endpoint).
 *
 * Throws `CurlParseError` (from detent) when the arguments don't form a valid
 * curl invocation (missing URL, malformed header, ...). The error message
 * carries useful detail for the user, so callers should surface it rather
 * than silently swallow it.
 */
export function extractUrlFromCurlArguments(args: readonly string[]): string | null {
  const parsedUrl = parseCurlArgs(args).url;
  if (!parsedUrl.startsWith('http://') && !parsedUrl.startsWith('https://')) {
    return null;
  }

  const normalizeArg = (arg: string): string | null => {
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(arg) ? arg : `http://${arg}`;
    try {
      return new URL(withScheme).href;
    } catch {
      return null;
    }
  };

  // Preferred: the argv token normalizes to exactly the parsed URL.
  for (const arg of args) {
    if (arg === parsedUrl || normalizeArg(arg) === parsedUrl) {
      return arg;
    }
  }

  // Fallback: the argv token matches when query string and fragment are
  // stripped from both sides. Covers `-G` with `--data-urlencode`/`-d`.
  const stripQueryAndFragment = (href: string): string => {
    try {
      const url = new URL(href);
      url.search = '';
      url.hash = '';
      return url.href;
    } catch {
      return href;
    }
  };
  const parsedUrlBase = stripQueryAndFragment(parsedUrl);
  for (const arg of args) {
    const normalized = normalizeArg(arg);
    if (normalized !== null && stripQueryAndFragment(normalized) === parsedUrlBase) {
      return arg;
    }
  }
  return null;
}
