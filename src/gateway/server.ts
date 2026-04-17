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

function sendErrorResponse(
  response: http.ServerResponse,
  statusCode: number,
  message: string
): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: message }));
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
