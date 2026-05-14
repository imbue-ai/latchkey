/**
 * CycleTLS transport for services that need browser-like TLS fingerprinting.
 *
 * CycleTLS is a Go-based HTTP client that impersonates Chrome's TLS handshake
 * (JA3 fingerprint), allowing requests to pass through Cloudflare bot detection.
 * The package is lazily loaded as an optional dependency.
 */

import type initCycleTLS from 'cycletls';

type CycleTLSClient = Awaited<ReturnType<typeof initCycleTLS>>;

const CHROME_JA3 =
  '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513-21,29-23-24,0';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export class CycleTlsNotAvailableError extends Error {
  constructor() {
    super('CycleTLS is not installed. Install it with: npm install cycletls');
    this.name = 'CycleTlsNotAvailableError';
  }
}

// Lazy singleton — the CycleTLS init spawns a Go binary, so we reuse it.
let instance: CycleTLSClient | null = null;
let initPromise: Promise<CycleTLSClient> | null = null;

async function getCycleTls(): Promise<CycleTLSClient> {
  if (instance !== null) return instance;
  if (initPromise !== null) return initPromise;

  initPromise = (async () => {
    try {
      // Dynamic import — cycletls is an optional dependency.
      const mod = await import('cycletls');
      instance = await mod.default();
      return instance;
    } catch (error) {
      initPromise = null;
      if (
        error instanceof Error &&
        (error.message.includes('Cannot find module') ||
          error.message.includes('Cannot find package') ||
          error.message.includes('ERR_MODULE_NOT_FOUND'))
      ) {
        throw new CycleTlsNotAvailableError();
      }
      throw error;
    }
  })();

  return initPromise;
}

export interface CycleTlsResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[]>;
  readonly body: string;
}

export interface ParsedHttpRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

/**
 * Parse curl-style arguments into an HTTP request. Extracts method, URL,
 * headers, and body while skipping curl output flags (-s, -o, -w, -D)
 * that have no HTTP meaning.
 */
export function parseCurlArgsToHttp(
  args: readonly string[],
  stdinBody?: Buffer
): ParsedHttpRequest {
  let method = 'GET';
  let url = '';
  const headers: Record<string, string> = {};
  let body: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    switch (arg) {
      case '-X':
      case '--request':
        method = args[++i]!;
        break;

      case '-H':
      case '--header': {
        const header = args[++i]!;
        const colonIndex = header.indexOf(':');
        if (colonIndex > 0) {
          headers[header.slice(0, colonIndex).trim()] = header.slice(colonIndex + 1).trim();
        }
        break;
      }

      case '-d':
      case '--data':
      case '--data-raw':
        body = args[++i]!;
        if (method === 'GET') method = 'POST';
        break;

      case '--data-binary': {
        const next = args[++i]!;
        if (next === '@-') {
          body = stdinBody?.toString('utf-8');
        } else {
          body = next;
        }
        if (method === 'GET') method = 'POST';
        break;
      }

      // Curl output/behavior flags — skip (with or without values).
      case '-s':
      case '-S':
      case '-sS':
      case '--silent':
      case '--show-error':
        break;
      case '-o':
      case '--output':
      case '-w':
      case '--write-out':
      case '-D':
      case '--dump-header':
        i++; // skip value
        break;

      default:
        // Positional argument = URL (last one wins, same as curl).
        if (!arg.startsWith('-')) {
          url = arg;
        }
        break;
    }
  }

  return { url, method, headers, body };
}

/**
 * Make an HTTP request via CycleTLS with a Chrome TLS fingerprint.
 */
export async function cycleTlsRequest(request: ParsedHttpRequest): Promise<CycleTlsResponse> {
  const tls = await getCycleTls();

  const resp = await tls(
    request.url,
    {
      ja3: CHROME_JA3,
      userAgent: USER_AGENT,
      headers: request.headers,
      disableRedirect: false,
      body: request.body,
    },
    request.method.toLowerCase()
  );

  let body: string;
  if (typeof resp.body === 'string') {
    body = resp.body;
  } else if (resp.body !== null && resp.body !== undefined) {
    body = JSON.stringify(resp.body);
  } else {
    body = '';
  }

  return {
    status: resp.status,
    headers: resp.headers ?? {},
    body,
  };
}

/**
 * Shut down the CycleTLS Go binary. Call on process exit.
 */
export async function closeCycleTls(): Promise<void> {
  if (instance !== null) {
    try {
      await instance.exit();
    } catch {
      // Ignore shutdown errors.
    }
    instance = null;
    initPromise = null;
  }
}
