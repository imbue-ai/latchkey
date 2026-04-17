/**
 * Local HTTP gateway that proxies requests through latchkey's credential injection pipeline.
 */

import * as http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ApiCredentialStore } from './apiCredentialStore.js';
import type { AsyncCurlResult } from './curl.js';
import type { CliDependencies } from './cliCommands.js';
import {
  CredentialsExpiredError,
  NoCredentialsForServiceError,
  NoServiceForUrlError,
  prepareCurlInvocation,
  RequestNotPermittedError,
  UrlExtractionFailedError,
} from './curlInjection.js';
import type { EncryptedStorage } from './encryptedStorage.js';
import { handleLatchkeyRequest } from './latchkeyEndpoint.js';
import { PermissionCheckError } from './permissions.js';
import { ErrorMessages } from './errorMessages.js';

/**
 * Headers that should not be forwarded between client and upstream (hop-by-hop).
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
]);

const GATEWAY_PATH_PREFIX = '/gateway/';

function sendErrorResponse(
  response: http.ServerResponse,
  statusCode: number,
  message: string
): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: message }));
}

export class BodyTooLargeError extends Error {
  constructor() {
    super(ErrorMessages.requestBodyTooLarge);
    this.name = 'BodyTooLargeError';
  }
}

/**
 * Extract the target URL from a raw gateway request URL.
 * Strips the `/gateway/` prefix and returns the target URL.
 * Returns null if the path doesn't start with `/gateway/` or the target URL is invalid.
 */
export function extractTargetUrl(rawUrl: string): string | null {
  const prefix = GATEWAY_PATH_PREFIX;
  if (!rawUrl.startsWith(prefix)) {
    return null;
  }
  const targetUrl = rawUrl.slice(prefix.length);
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    return null;
  }
  return targetUrl;
}

/**
 * Build curl arguments from an HTTP request's components.
 * Strips hop-by-hop headers and constructs a curl-compatible argument array.
 */
export function buildCurlArguments(
  method: string,
  headers: ReadonlyMap<string, string>,
  targetUrl: string,
  hasBody: boolean
): readonly string[] {
  const args: string[] = [];

  if (method !== 'GET') {
    args.push('-X', method);
  }

  for (const [name, value] of headers) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      continue;
    }
    args.push('-H', `${name}: ${value}`);
  }

  if (hasBody) {
    args.push('--data-binary', '@-');
  }

  args.push(targetUrl);

  return args;
}

/**
 * Parse response headers from curl's -D output.
 * Returns the status code from the last status line and all response headers.
 */
export function parseResponseHeaders(headerDump: string): {
  statusCode: number;
  headers: ReadonlyMap<string, readonly string[]>;
} {
  const headers = new Map<string, string[]>();
  let statusCode = 0;

  // curl may output multiple status lines (e.g. 100 Continue, redirects).
  // We parse from the beginning and reset on each new status line,
  // so we end up with the headers from the final response.
  const lines = headerDump.split(/\r?\n/);
  for (const line of lines) {
    // Status line: "HTTP/1.1 200 OK" or "HTTP/2 200"
    const statusMatch = /^HTTP\/[\d.]+ (\d+)/.exec(line);
    if (statusMatch !== null) {
      statusCode = parseInt(statusMatch[1]!, 10);
      headers.clear();
      continue;
    }

    // Header line: "Content-Type: application/json"
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const name = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      const lowerName = name.toLowerCase();
      const existing = headers.get(lowerName);
      if (existing !== undefined) {
        existing.push(value);
      } else {
        headers.set(lowerName, [value]);
      }
    }
  }

  return { statusCode, headers };
}

/**
 * Read the full request body, enforcing a size limit.
 */
function readRequestBody(
  request: http.IncomingMessage,
  maxBodySize: number
): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const contentLength = request.headers['content-length'];
    if (contentLength !== undefined) {
      const size = parseInt(contentLength, 10);
      if (!isNaN(size) && size > maxBodySize) {
        reject(new BodyTooLargeError());
        return;
      }
    }

    const chunks: Buffer[] = [];
    let totalSize = 0;

    request.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > maxBodySize) {
        request.destroy();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      if (totalSize === 0) {
        resolve(null);
        return;
      }
      resolve(Buffer.concat(chunks));
    });

    request.on('error', reject);
  });
}

export interface GatewayOptions {
  readonly port: number;
  readonly host: string;
  readonly maxBodySize: number;
}

/**
 * Execute a proxied request through the credential injection pipeline.
 */
async function handleGatewayRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  targetUrl: string,
  deps: CliDependencies,
  apiCredentialStore: ApiCredentialStore,
  options: GatewayOptions
): Promise<void> {
  // Read body
  let body: Buffer | null;
  try {
    body = await readRequestBody(request, options.maxBodySize);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      const method = request.method ?? 'UNKNOWN';
      deps.log(`${method} ${targetUrl} -> 413`);
      sendErrorResponse(response, 413, error.message);
      return;
    }
    throw error;
  }

  // Build curl arguments from the incoming request
  const method = request.method ?? 'GET';
  const headerMap = new Map<string, string>();
  const rawHeaders = request.rawHeaders;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]!;
    const value = rawHeaders[i + 1]!;
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      headerMap.set(name, value);
    }
  }

  const curlArguments = buildCurlArguments(method, headerMap, targetUrl, body !== null);

  let allArguments: readonly string[];
  try {
    allArguments = await prepareCurlInvocation(curlArguments, apiCredentialStore, {
      registry: deps.registry,
      checkPermission: deps.checkPermission,
      permissionsConfigPath: deps.config.permissionsConfigPath,
      permissionsDoNotUseBuiltinSchemas: deps.config.permissionsDoNotUseBuiltinSchemas,
      passthroughUnknown: deps.config.passthroughUnknown,
    });
  } catch (error) {
    if (error instanceof RequestNotPermittedError) {
      deps.log(`${method} ${targetUrl} -> 403`);
      sendErrorResponse(response, 403, error.message);
      return;
    }
    if (error instanceof PermissionCheckError) {
      deps.log(`${method} ${targetUrl} -> 403`);
      sendErrorResponse(response, 403, `Error: ${error.message}`);
      return;
    }
    if (
      error instanceof UrlExtractionFailedError ||
      error instanceof NoServiceForUrlError ||
      error instanceof NoCredentialsForServiceError ||
      error instanceof CredentialsExpiredError
    ) {
      deps.log(`${method} ${targetUrl} -> 400`);
      sendErrorResponse(response, 400, error.message);
      return;
    }
    throw error;
  }

  // Create temp directory for header dump
  const tempDir = mkdtempSync(join(tmpdir(), 'latchkey-gw-'));
  const headerFile = join(tempDir, 'headers');

  try {
    // Add curl flags for capturing response metadata
    const curlArgs = ['-s', '-D', headerFile, ...allArguments];

    const result: AsyncCurlResult = await deps.runCurlAsync(curlArgs, {
      stdin: body ?? undefined,
    });

    if (result.returncode !== 0) {
      // Try to read headers in case curl got a response before failing
      let headerDump: string;
      try {
        headerDump = readFileSync(headerFile, 'utf-8');
      } catch {
        deps.log(`${method} ${targetUrl} -> 502`);
        sendErrorResponse(response, 502, ErrorMessages.upstreamRequestFailed);
        return;
      }

      if (headerDump.trim() === '') {
        deps.log(`${method} ${targetUrl} -> 502`);
        sendErrorResponse(response, 502, ErrorMessages.upstreamRequestFailed);
        return;
      }

      // We got headers — forward whatever we have
      const parsed = parseResponseHeaders(headerDump);
      forwardResponse(response, parsed, result.stdout);
      deps.log(`${method} ${targetUrl} -> ${String(parsed.statusCode)}`);
      return;
    }

    // Read response headers
    let headerDump: string;
    try {
      headerDump = readFileSync(headerFile, 'utf-8');
    } catch {
      deps.log(`${method} ${targetUrl} -> 502`);
      sendErrorResponse(response, 502, ErrorMessages.upstreamRequestFailed);
      return;
    }

    const parsed = parseResponseHeaders(headerDump);
    const statusCode = parsed.statusCode || 200;

    forwardResponse(response, { statusCode, headers: parsed.headers }, result.stdout);
    deps.log(`${method} ${targetUrl} -> ${String(statusCode)}`);
  } finally {
    // Clean up temp files
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Forward parsed upstream response to the client.
 */
function forwardResponse(
  response: http.ServerResponse,
  parsed: { statusCode: number; headers: ReadonlyMap<string, readonly string[]> },
  body: Buffer
): void {
  for (const [name, values] of parsed.headers) {
    if (HOP_BY_HOP_HEADERS.has(name)) {
      continue;
    }
    if (values.length === 1) {
      response.setHeader(name, values[0]!);
    } else {
      response.setHeader(name, [...values]);
    }
  }
  response.writeHead(parsed.statusCode);
  response.end(body);
}

export interface GatewayServer {
  readonly server: http.Server;
  readonly close: () => Promise<void>;
}

/**
 * Start the gateway HTTP server.
 */
export function startGateway(
  deps: CliDependencies,
  apiCredentialStore: ApiCredentialStore,
  encryptedStorage: EncryptedStorage,
  options: GatewayOptions
): Promise<GatewayServer> {
  const inFlightRequests = new Set<Promise<void>>();

  const server = http.createServer((request, response) => {
    const rawUrl = request.url ?? '';

    // Health endpoint
    if (rawUrl === '/' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', version: deps.version }));
      return;
    }

    // Latchkey RPC endpoint
    if (rawUrl === '/latchkey/' || rawUrl === '/latchkey') {
      const requestPromise = handleLatchkeyRequest(
        request,
        response,
        deps,
        apiCredentialStore,
        encryptedStorage
      ).catch((error: unknown) => {
        deps.errorLog(
          `Unexpected error handling /latchkey/: ${error instanceof Error ? error.message : String(error)}`
        );
        if (!response.headersSent) {
          sendErrorResponse(response, 500, 'Internal error');
        }
      });

      inFlightRequests.add(requestPromise);
      void requestPromise.finally(() => {
        inFlightRequests.delete(requestPromise);
      });
      return;
    }

    // Extract target URL
    const targetUrl = extractTargetUrl(rawUrl);
    if (targetUrl === null) {
      if (rawUrl.startsWith(GATEWAY_PATH_PREFIX)) {
        const method = request.method ?? 'UNKNOWN';
        deps.log(`${method} ${rawUrl.slice(GATEWAY_PATH_PREFIX.length)} -> 400`);
        sendErrorResponse(response, 400, ErrorMessages.couldNotExtractUrl);
      } else {
        response.writeHead(404);
        response.end();
      }
      return;
    }

    const requestPromise = handleGatewayRequest(
      request,
      response,
      targetUrl,
      deps,
      apiCredentialStore,
      options
    ).catch((error: unknown) => {
      const method = request.method ?? 'UNKNOWN';
      deps.errorLog(
        `Unexpected error handling ${method} ${targetUrl}: ${error instanceof Error ? error.message : String(error)}`
      );
      if (!response.headersSent) {
        sendErrorResponse(response, 502, ErrorMessages.upstreamRequestFailed);
      }
    });

    inFlightRequests.add(requestPromise);
    void requestPromise.finally(() => {
      inFlightRequests.delete(requestPromise);
    });
  });

  const SHUTDOWN_TIMEOUT_MS = 10_000;

  const close = (): Promise<void> => {
    return new Promise((resolve) => {
      deps.log('Shutting down...');
      server.close(() => {
        resolve();
      });

      // Force-close after timeout
      setTimeout(() => {
        server.closeAllConnections();
        resolve();
      }, SHUTDOWN_TIMEOUT_MS);
    });
  };

  return new Promise((resolve, reject) => {
    server.on('error', reject);

    server.listen(options.port, options.host, () => {
      deps.log(`Latchkey gateway listening on ${options.host}:${String(options.port)}`);
      resolve({ server, close });
    });
  });
}
