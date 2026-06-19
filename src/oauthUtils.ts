/**
 * Generic OAuth utilities for localhost callback server and token exchange.
 */

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { runCaptured } from './curl.js';
import { LoginCancelledError, LoginFailedError } from './services/core/base.js';

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

export interface OAuthTokenExchangeResponse extends OAuthTokenResponse {
  refresh_token: string;
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

export interface OAuthCallbackParamsServer {
  /** The port the server is listening on */
  port: number;
  /**
   * Promise that resolves with every query parameter from the callback once the
   * authorization code is received (guaranteed to include `code`). Useful for
   * flows that return extra parameters alongside the code, such as QuickBooks'
   * `realmId`.
   */
  paramsPromise: Promise<Record<string, string>>;
}

/**
 * Start a temporary HTTP server to receive an OAuth callback, resolving with all
 * of the callback's query parameters.
 *
 * Most flows only need the authorization code (see {@link startOAuthCallbackServer},
 * which wraps this). Use this directly when the provider returns extra parameters
 * that must be captured, e.g. QuickBooks' `realmId`.
 *
 * @param timeoutMs - Timeout in milliseconds
 * @param signal - Optional AbortSignal to cancel the server early
 * @param callbackPath - Path to listen for OAuth callback (default: '/oauth2callback')
 * @param port - Port to bind (default 0 = auto-assign). Pass a fixed port when the
 *   provider requires the exact redirect URI (incl. port) to be pre-registered.
 */
export function startOAuthCallbackServerForParams(
  timeoutMs: number,
  signal?: AbortSignal,
  callbackPath = '/oauth2callback',
  port = 0
): Promise<OAuthCallbackParamsServer> {
  const server = http.createServer();

  return new Promise<OAuthCallbackParamsServer>((resolveServer, rejectServer) => {
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

      const boundPort = address.port;
      let timeout: NodeJS.Timeout | undefined;

      const paramsPromise = new Promise<Record<string, string>>((resolve, reject) => {
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
          const parsedUrl = new URL(req.url ?? '', `http://localhost:${boundPort.toString()}`);

          if (parsedUrl.pathname === callbackPath) {
            const code = parsedUrl.searchParams.get('code') ?? undefined;

            if (code) {
              res.writeHead(200, { 'Content-Type': 'text/plain' });
              res.end('OK');
              signal?.removeEventListener('abort', abortHandler);
              cleanup();
              resolve(Object.fromEntries(parsedUrl.searchParams.entries()));
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

      resolveServer({ port: boundPort, paramsPromise });
    });
  });
}

/**
 * Start a temporary HTTP server to receive OAuth callback.
 * Returns the assigned port and a promise that resolves with the authorization code.
 * The server uses port 0 to get an auto-assigned available port.
 * @param timeoutMs - Timeout in milliseconds
 * @param signal - Optional AbortSignal to cancel the server early
 * @param callbackPath - Path to listen for OAuth callback (default: '/oauth2callback')
 */
export function startOAuthCallbackServer(
  timeoutMs: number,
  signal?: AbortSignal,
  callbackPath = '/oauth2callback'
): Promise<OAuthCallbackServer> {
  return startOAuthCallbackServerForParams(timeoutMs, signal, callbackPath).then(
    ({ port, paramsPromise }) => ({
      port,
      // paramsPromise only resolves once a code is present, but the index type is
      // widened to `string | undefined`; fall back defensively.
      codePromise: paramsPromise.then((params) => {
        const code = params.code;
        if (code === undefined) {
          throw new LoginFailedError('No authorization code received from OAuth callback.');
        }
        return code;
      }),
    })
  );
}

/**
 * Generate a PKCE code verifier (RFC 7636).
 */
export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Generate a PKCE code challenge from a verifier using S256.
 */
export function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Exchange authorization code for access and refresh tokens.
 * @param tokenEndpoint - The OAuth token endpoint URL
 * @param code - The authorization code received from the OAuth callback
 * @param clientId - The OAuth client ID
 * @param clientSecret - The OAuth client secret (empty string for public clients)
 * @param redirectUri - The redirect URI used in the authorization request
 * @param codeVerifier - Optional PKCE code verifier
 */
export function exchangeCodeForTokens(
  tokenEndpoint: string,
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  codeVerifier?: string
): OAuthTokenExchangeResponse {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  if (clientSecret) {
    body.set('client_secret', clientSecret);
  }
  if (codeVerifier) {
    body.set('code_verifier', codeVerifier);
  }

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
    if (!response.access_token || !response.refresh_token) {
      throw new OAuthTokenExchangeError('Token response missing access_token or refresh_token.');
    }
    return response as OAuthTokenExchangeResponse;
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
    grant_type: 'refresh_token',
  });
  if (clientSecret) {
    body.set('client_secret', clientSecret);
  }

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
