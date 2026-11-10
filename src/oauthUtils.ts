/**
 * Generic OAuth utilities for localhost callback server and token exchange.
 */

import * as crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import { type ApiCredentials, OAuthCredentials } from './apiCredentials/base.js';
import { equalsInConstantTime } from './constantTimeEquals.js';
import { runCapturedAsync } from './curl.js';
import { LoginCancelledError, LoginFailedError } from './services/core/base.js';

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  /**
   * The scopes actually granted, space-delimited (RFC 6749 §5.1). Servers
   * must send it when it differs from what was requested, which is how a
   * user ticking only some of the consent screen's checkboxes shows up.
   */
  scope?: string;
}

export interface OAuthTokenExchangeResponse extends OAuthTokenResponse {
  refresh_token: string;
}

/**
 * Which of the requested scopes a token response's `scope` field does not
 * list. An absent field means the server granted exactly what was requested
 * (RFC 6749 §5.1), so nothing is missing then.
 */
export function findScopesNotGranted(
  requestedScopes: readonly string[],
  grantedScopeField: string | undefined
): readonly string[] {
  if (grantedScopeField === undefined) {
    return [];
  }
  const grantedScopes = new Set(grantedScopeField.split(/\s+/).filter((scope) => scope !== ''));
  return requestedScopes.filter((scope) => !grantedScopes.has(scope));
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

/**
 * The path the loopback callback server listens on by default.
 */
export const DEFAULT_OAUTH_CALLBACK_PATH = '/oauth2callback';

/**
 * The loopback redirect URI for a login that receives the authorization code
 * itself, on the port {@link startOAuthCallbackServer} picked.
 */
export function buildLoopbackRedirectUri(
  port: number,
  callbackPath: string = DEFAULT_OAUTH_CALLBACK_PATH
): string {
  return `http://localhost:${port.toString()}${callbackPath}`;
}

/**
 * The pre-registered redirect URI to use instead of a loopback one, as stored
 * by `latchkey auth prepare`; undefined when there is none and login should
 * receive the authorization code directly. See
 * {@link OAuthCredentials.redirectUri}.
 */
export function readRedirectUriOverride(credentials?: ApiCredentials): string | undefined {
  return credentials instanceof OAuthCredentials ? credentials.redirectUri : undefined;
}

/**
 * The `state` for an authorization request, carrying the loopback port login
 * is waiting on in its last dot-separated segment.
 *
 * A prepared redirect URI (see `OAuthCredentials.redirectUri`) points the
 * authorization server at a page latchkey does not control, and that page has
 * to forward the result to a loopback port it cannot know in advance —
 * `startOAuthCallbackServer` picks a free one per login. The server echoes
 * `state` back unchanged, so it is the one channel available for telling the
 * page where to forward to. The random prefix keeps the value unguessable,
 * which is what `state` is for (RFC 6749 §10.12); it is sent for loopback
 * logins too, so that both paths look alike.
 */
export function buildAuthorizationState(loopbackPort: number): string {
  return `${randomUUID()}.${loopbackPort.toString()}`;
}

export interface OAuthCallbackServer {
  /** The port the server is listening on */
  port: number;
  /** Promise that resolves with the authorization code when received */
  codePromise: Promise<string>;
  /**
   * The `state` to send on the authorization request (see
   * {@link buildAuthorizationState}). The server insists on the callback
   * echoing it only when started with `validateState`.
   */
  state: string;
}

export interface OAuthCallbackServerOptions {
  /**
   * Refuse callbacks that do not carry {@link OAuthCallbackServer.state}
   * (RFC 6749 §10.12). Anything running on the machine can request the
   * loopback callback; only the authorization server's redirect knows the
   * state, so a request without it is answered with 400 and otherwise
   * ignored: it neither completes nor aborts the login. Opt-in because
   * plugins built on earlier versions send no state at all.
   */
  readonly validateState?: boolean;
}

export type OAuthCallbackOutcome =
  | { readonly succeeded: true }
  | { readonly succeeded: false; readonly reason: string };

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * The page the browser lands on after the authorization server redirects it
 * to the loopback callback. It matters for the system browser, where it stays
 * open: Latchkey cannot close a tab it did not open, and browsers refuse to
 * let a page close itself unless a script opened it. So the page says what
 * happened and that the tab can go. It does not name Latchkey: when Latchkey
 * is embedded in an application, the user may never have heard of it.
 */
export function buildOAuthCallbackPageHtml(outcome: OAuthCallbackOutcome): string {
  const heading = outcome.succeeded ? 'Login complete' : 'Login failed';
  const detail = outcome.succeeded
    ? 'You can close this tab.'
    : `${escapeHtml(outcome.reason)} You can close this tab and try again.`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${heading}</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f5f5f5;
      color: #333;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    main { max-width: 32em; padding: 2em; text-align: center; }
    h1 { font-size: 1.5em; margin: 0 0 0.5em; }
    p { color: #555; line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <h1>${heading}</h1>
    <p>${detail}</p>
  </main>
</body>
</html>
`;
}

/**
 * How long the user has to get through the authorization page before the
 * callback server gives up: signing in (password manager, second factor),
 * then the consent screen, and the odd detour such as an account chooser.
 *
 * The same for every login on purpose. The timeout is there to stop an
 * abandoned login from holding a port forever, not to hurry anyone, so it is
 * generous; and nothing distinguishes one service's users from another's in
 * how long that takes. A login in the browser Latchkey controls ends as soon
 * as the browser is closed regardless; for the system browser this is the only
 * way an abandoned login ends.
 */
export const OAUTH_CALLBACK_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Start a temporary HTTP server to receive OAuth callback.
 * Returns the assigned port and a promise that resolves with the authorization code.
 * The server uses port 0 to get an auto-assigned available port.
 * The code promise rejects with {@link OAuthCallbackServerTimeoutError} after
 * {@link OAUTH_CALLBACK_TIMEOUT_MS}.
 * @param signal - Optional AbortSignal to cancel the server early
 * @param callbackPath - Path to listen for OAuth callback (default: '/oauth2callback')
 */
export function startOAuthCallbackServer(
  signal?: AbortSignal,
  callbackPath: string = DEFAULT_OAUTH_CALLBACK_PATH,
  options: OAuthCallbackServerOptions = {}
): Promise<OAuthCallbackServer> {
  const server = http.createServer();

  return new Promise<OAuthCallbackServer>((resolveServer, rejectServer) => {
    server.on('error', (error) => {
      rejectServer(error);
    });

    server.listen(0, 'localhost', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        rejectServer(new Error('Failed to get server address'));
        return;
      }

      const port = address.port;
      const state = buildAuthorizationState(port);
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
            if (options.validateState === true) {
              const receivedState = parsedUrl.searchParams.get('state');
              if (receivedState === null || !equalsInConstantTime(state, receivedState)) {
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(
                  buildOAuthCallbackPageHtml({
                    succeeded: false,
                    reason: 'The callback did not carry the expected state.',
                  })
                );
                return;
              }
            }

            const code = parsedUrl.searchParams.get('code') ?? undefined;

            if (code) {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(buildOAuthCallbackPageHtml({ succeeded: true }));
              signal?.removeEventListener('abort', abortHandler);
              cleanup();
              resolve(code);
            } else {
              // No code means the authorization server refused. RFC 6749 §4.1.2.1
              // puts the reason in `error` / `error_description`; reporting the
              // bare absence of a code instead leaves the caller with nothing to
              // act on.
              const error = parsedUrl.searchParams.get('error');
              const errorDescription = parsedUrl.searchParams.get('error_description');
              const reason =
                error === null
                  ? 'No authorization code received from OAuth callback.'
                  : `Authorization failed: ${error}` +
                    (errorDescription === null ? '' : ` (${errorDescription})`);
              res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(buildOAuthCallbackPageHtml({ succeeded: false, reason }));
              signal?.removeEventListener('abort', abortHandler);
              cleanup();
              reject(new LoginFailedError(reason));
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
        }, OAUTH_CALLBACK_TIMEOUT_MS);

        server.on('error', (error) => {
          signal?.removeEventListener('abort', abortHandler);
          cleanup();
          reject(error);
        });
      });

      resolveServer({ port, codePromise, state });
    });
  });
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
export interface ExchangeCodeForTokensOptions {
  /**
   * Accept a token response without a refresh token. The default insists on
   * one, since credentials that cannot be refreshed are a poor outcome of a
   * login; a server that is known to issue short-lived tokens only, or that
   * leaves refresh tokens to the client's discretion, opts out.
   */
  readonly refreshTokenRequired?: boolean;
}

export async function exchangeCodeForTokens(
  tokenEndpoint: string,
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  codeVerifier?: string,
  extraParams?: Readonly<Record<string, string>>
): Promise<OAuthTokenExchangeResponse>;
export async function exchangeCodeForTokens(
  tokenEndpoint: string,
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  codeVerifier: string | undefined,
  extraParams: Readonly<Record<string, string>> | undefined,
  options: ExchangeCodeForTokensOptions
): Promise<OAuthTokenResponse>;
export async function exchangeCodeForTokens(
  tokenEndpoint: string,
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  codeVerifier?: string,
  extraParams?: Readonly<Record<string, string>>,
  options: ExchangeCodeForTokensOptions = {}
): Promise<OAuthTokenResponse> {
  const refreshTokenRequired = options.refreshTokenRequired ?? true;
  // Extras first, so the protocol fields below always win: a caller cannot
  // accidentally replace `grant_type` or `code` with its own value. Servers that
  // pin tokens to a named audience need their own parameters here, e.g. RFC
  // 8707's `resource`.
  const body = new URLSearchParams({ ...extraParams });
  body.set('code', code);
  body.set('client_id', clientId);
  body.set('redirect_uri', redirectUri);
  body.set('grant_type', 'authorization_code');
  if (clientSecret) {
    body.set('client_secret', clientSecret);
  }
  if (codeVerifier) {
    body.set('code_verifier', codeVerifier);
  }

  const result = await runCapturedAsync(
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
    const response = JSON.parse(result.stdout) as OAuthTokenResponse & {
      error?: string;
      error_description?: string;
    };
    if (!response.access_token || (refreshTokenRequired && !response.refresh_token)) {
      // A refusal is reported as `error` / `error_description` (RFC 6749 §5.2);
      // reporting only the absent fields discards the reason.
      const reason =
        response.error === undefined
          ? refreshTokenRequired
            ? 'Token response missing access_token or refresh_token.'
            : 'Token response missing access_token.'
          : `Token exchange failed: ${response.error}` +
            (response.error_description === undefined ? '' : ` (${response.error_description})`);
      throw new OAuthTokenExchangeError(reason);
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
export async function refreshAccessToken(
  tokenEndpoint: string,
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  extraParams?: Readonly<Record<string, string>>
): Promise<OAuthTokenResponse | null> {
  // Extras first so the protocol fields win (see exchangeCodeForTokens). A
  // refresh has to name the same audience the original grant did, or a server
  // that pins tokens to a resource will refuse it.
  const body = new URLSearchParams({ ...extraParams });
  body.set('refresh_token', refreshToken);
  body.set('client_id', clientId);
  body.set('grant_type', 'refresh_token');
  if (clientSecret) {
    body.set('client_secret', clientSecret);
  }

  const result = await runCapturedAsync(
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
