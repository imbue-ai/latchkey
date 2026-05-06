/**
 * Local HTTP gateway server.
 *
 * Routes incoming requests to either the `/gateway/<target-url>` proxy handler
 * or the `/latchkey/` RPC endpoint.
 */

import * as http from 'node:http';
import type { ApiCredentialStore } from '../apiCredentials/store.js';
import type { CliDependencies } from '../cliCommands.js';
import type { EncryptedStorage } from '../encryptedStorage.js';
import { ErrorMessages } from '../errorMessages.js';
import {
  extractTargetUrl,
  GATEWAY_PATH_PREFIX,
  handleGatewayRequest,
  type GatewayOptions,
} from './gatewayEndpoint.js';
import { handleLatchkeyRequest } from './latchkeyEndpoint.js';
import { GATEWAY_PASSWORD_HEADER, passwordsMatch } from './password.js';

function sendErrorResponse(
  response: http.ServerResponse,
  statusCode: number,
  message: string
): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: message }));
}

/**
 * Read a single header value, treating arrays (which Node returns for some
 * headers) as missing because the password header is not allowed to repeat.
 */
function readSingleHeader(request: http.IncomingMessage, headerName: string): string | undefined {
  const value = request.headers[headerName];
  if (typeof value === 'string') return value;
  return undefined;
}

/**
 * If a password is configured, verify that the request presents it in the
 * expected header. Returns true when the request should be allowed to
 * proceed, and writes a 401 response and returns false otherwise.
 */
function enforcePassword(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  expectedPassword: string | null,
  deps: CliDependencies
): boolean {
  if (expectedPassword === null) return true;
  const provided = readSingleHeader(request, GATEWAY_PASSWORD_HEADER);
  if (provided !== undefined && passwordsMatch(expectedPassword, provided)) {
    return true;
  }
  const method = request.method ?? 'UNKNOWN';
  const path = request.url ?? '';
  deps.log(`${method} ${path} -> 401 (password)`);
  sendErrorResponse(response, 401, 'Unauthorized: invalid or missing Latchkey gateway password.');
  return false;
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

    if (!enforcePassword(request, response, options.password, deps)) {
      return;
    }

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
      const passwordNote = options.password === null ? '' : ' (password authentication enabled)';
      deps.log(
        `Latchkey gateway listening on ${options.host}:${String(options.port)}${passwordNote}`
      );
      resolve({ server, close });
    });
  });
}
