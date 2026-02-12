/**
 * Generic OAuth utilities for localhost callback server and token exchange.
 */

import * as http from 'node:http';
import { runCaptured } from './curl.js';
import { LoginCancelledError, LoginFailedError } from './services/base.js';

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type: string;
}

export class OAuthTokenExchangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthTokenExchangeError';
  }
}

export class OAuthCallbackServerTimeoutError extends Error {
  constructor() {
    super('OAuth callback server timed out waiting for authorization code.');
    this.name = 'OAuthCallbackServerTimeoutError';
  }
}

export interface OAuthCallbackServer {
  /** The port the server is listening on */
  port: number;
  /** Promise that resolves with the authorization code when received */
  codePromise: Promise<string>;
}

/**
 * Start a temporary HTTP server to receive OAuth callback.
 * Returns the assigned port and a promise that resolves with the authorization code.
 * @param timeoutMs - Timeout in milliseconds
 * @param signal - Optional AbortSignal to cancel the server early
 * @param callbackPath - Path to listen for OAuth callback (default: '/oauth2callback')
 * @param port - Port to listen on (default: 0 for auto-assign)
 */
export function startOAuthCallbackServer(
  timeoutMs: number,
  signal?: AbortSignal,
  callbackPath = '/oauth2callback',
  port = 0
): Promise<OAuthCallbackServer> {
  const server = http.createServer();

  return new Promise<OAuthCallbackServer>((resolveServer, rejectServer) => {
    server.on('error', (error) => {
      rejectServer(error);
    });

    server.listen(port, 'localhost', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        rejectServer(new Error('Failed to get server address'));
        return;
      }

      const port = address.port;
      let timeout: NodeJS.Timeout | undefined;

      const codePromise = new Promise<string>((resolve, reject) => {
        const cleanup = () => {
          if (timeout !== undefined) {
            clearTimeout(timeout);
          }
          server.closeAllConnections();
          server.close();
        };

        const abortHandler = () => {
          cleanup();
          reject(new LoginCancelledError());
        };

        if (signal) {
          if (signal.aborted) {
            cleanup();
            reject(new LoginCancelledError());
            return;
          }
          signal.addEventListener('abort', abortHandler, { once: true });
        }

        server.on('request', (req, res) => {
          const parsedUrl = new URL(req.url ?? '', `http://localhost:${port.toString()}`);

          if (parsedUrl.pathname === callbackPath) {
            const code = parsedUrl.searchParams.get('code') ?? undefined;

            if (code) {
              res.writeHead(200, { 'Content-Type': 'text/plain' });
              res.end('OK');
              signal?.removeEventListener('abort', abortHandler);
              cleanup();
              resolve(code);
            } else {
              res.writeHead(400, { 'Content-Type': 'text/plain' });
              res.end('ERROR');
              signal?.removeEventListener('abort', abortHandler);
              cleanup();
              reject(new LoginFailedError('No authorization code received from OAuth callback.'));
            }
          } else {
            res.writeHead(404);
            res.end();
          }
        });

        timeout = setTimeout(() => {
          signal?.removeEventListener('abort', abortHandler);
          cleanup();
          reject(new OAuthCallbackServerTimeoutError());
        }, timeoutMs);

        server.on('error', (error) => {
          signal?.removeEventListener('abort', abortHandler);
          cleanup();
          reject(error);
        });
      });

      resolveServer({ port, codePromise });
    });
  });
}

/**
 * Exchange authorization code for access and refresh tokens.
 * @param tokenEndpoint - The OAuth token endpoint URL
 * @param code - The authorization code received from the OAuth callback
 * @param clientId - The OAuth client ID
 * @param clientSecret - The OAuth client secret
 * @param redirectUri - The redirect URI used in the authorization request
 */
export function exchangeCodeForTokens(
  tokenEndpoint: string,
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): OAuthTokenResponse {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const result = runCaptured(
    [
      '-s',
      '-X',
      'POST',
      '-H',
      'Content-Type: application/x-www-form-urlencoded',
      '-d',
      body.toString(),
      tokenEndpoint,
    ],
    30
  );

  if (result.returncode !== 0) {
    throw new OAuthTokenExchangeError(
      `Failed to exchange authorization code for tokens: ${result.stderr}`
    );
  }

  try {
    const response = JSON.parse(result.stdout) as OAuthTokenResponse;
    if (!response.access_token) {
      throw new OAuthTokenExchangeError(
        `Token response missing access_token. Response body: ${result.stdout}`
      );
    }
    return response;
  } catch (error: unknown) {
    if (error instanceof OAuthTokenExchangeError) {
      throw error;
    }
    throw new OAuthTokenExchangeError(
      `Failed to parse token response: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Refresh OAuth access token using the refresh token.
 * @param tokenEndpoint - The OAuth token endpoint URL
 * @param refreshToken - The refresh token
 * @param clientId - The OAuth client ID
 * @param clientSecret - The OAuth client secret
 * @returns The new token response, or null if refresh failed
 */
export function refreshAccessToken(
  tokenEndpoint: string,
  refreshToken: string,
  clientId: string,
  clientSecret: string
): OAuthTokenResponse | null {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  });

  const result = runCaptured(
    [
      '-s',
      '-X',
      'POST',
      '-H',
      'Content-Type: application/x-www-form-urlencoded',
      '-d',
      body.toString(),
      tokenEndpoint,
    ],
    30
  );

  if (result.returncode !== 0) {
    return null;
  }

  try {
    const response = JSON.parse(result.stdout) as OAuthTokenResponse;
    if (!response.access_token) {
      return null;
    }
    return response;
  } catch {
    return null;
  }
}
