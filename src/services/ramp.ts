/**
 * Ramp service implementation (browser / AI agent-key pathway, production only).
 *
 * `latchkey auth browser ramp` runs the OAuth 2.0 authorization-code + PKCE flow
 * against Ramp's public client (a fixed client ID, no secret). The hosted consent
 * screen (auth_level=auto) mints an "AI agent key"; latchkey catches the loopback
 * callback, exchanges the code for a bearer + refresh token at
 * `.../developer/v1/token/pkce`, and stores them as OAuthCredentials (auto-refreshed).
 *
 * Agent keys use the agent-tools endpoints -- POST https://api.ramp.com/developer/v1/
 * agent-tools/<tool> with a {"rationale": ...} body (they are auth-level barred from
 * the standard REST endpoints). Spec: https://api.ramp.com/v1/public/agent-tools/spec/.
 */

import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Response } from 'playwright';
import {
  ApiCredentials,
  ApiCredentialsUsageError,
  OAuthCredentials,
} from '../apiCredentials/base.js';
import { DEFAULT_ACCOUNT } from '../apiCredentials/account.js';
import { runCaptured } from '../curl.js';
import {
  exchangeCodeForTokens,
  generateCodeChallenge,
  generateCodeVerifier,
  refreshAccessToken,
  startOAuthCallbackServer,
} from '../oauthUtils.js';
import {
  isBrowserClosedError,
  type LoginResult,
  LoginCancelledError,
  Service,
  ServiceSession,
  tryParseJson,
} from './core/base.js';

/** Ramp's public OAuth client (PKCE, no secret), from ramp-cli. */
const RAMP_OAUTH_CLIENT_ID = 'ramp_id_6pKvd0IR3d8Kuzp82SV6YgpVCZOlz68Px6s3wVsr';

/** Hosted authorize endpoint (where the user signs in / approves the agent key). */
const RAMP_AUTHORIZE_URL = 'https://app.ramp.com/v1/authorize';

/** PKCE token endpoint (code exchange + refresh). */
const RAMP_PKCE_TOKEN_ENDPOINT = 'https://api.ramp.com/developer/v1/token/pkce';

/** Loopback callback path; matches ramp-cli's `/callback`. */
const RAMP_OAUTH_CALLBACK_PATH = '/callback';

/** Time to wait for the user to finish the hosted login + agent-key approval. */
const RAMP_LOGIN_TIMEOUT_MS = 300_000;

/**
 * Scopes requested on the authorize URL: exactly the scopes Ramp's agent-tools
 * OpenAPI declares (no regular-REST-only scopes -- agent keys can't use the standard
 * REST API anyway). Ramp grants only the subset the signed-in user is entitled to
 * (returned in the token's `scope`), so over-requesting is harmless, but omitting a
 * scope an endpoint needs fails at call time with DEVELOPER_7100.
 */
const RAMP_OAUTH_SCOPES = [
  'accounting:read',
  'ai_spend:read',
  'approvals:write',
  'bills:read',
  'cards:read_agentic',
  'cards:write',
  'comments:write',
  'funds:write',
  'limits:read',
  'limits:write',
  'memos:read',
  'purchase_orders:read',
  'receipts:write',
  'reimbursements:read',
  'reimbursements:write',
  'tasks:read',
  'transactions:read',
  'transactions:write',
  'treasury:read',
  'trips:read',
  'trips:write',
  'unified_requests:read',
  'users:read',
  'vendors:read',
  'vendors:write',
  'x402:write',
].join(' ');

/**
 * Browser login session: runs the OAuth authorization-code + PKCE flow in a
 * Playwright browser and returns OAuthCredentials. login() is overridden wholesale
 * (the base template's static loginUrl + response-watching model doesn't fit a
 * per-session authorize URL with a localhost callback), mirroring NotionMcpSession.
 */
class RampOAuthServiceSession extends ServiceSession {
  onResponse(_response: Response): void {
    // Not used -- login completion is signalled by the OAuth callback, not by
    // inspecting page responses.
  }

  protected isLoginComplete(): boolean {
    // Not used -- login() is overridden entirely.
    return false;
  }

  protected finalizeCredentials(
    _browser: Browser,
    _context: BrowserContext,
    _oldCredentials?: ApiCredentials
  ): Promise<ApiCredentials | null> {
    // Not used -- login() is overridden entirely.
    return Promise.resolve(null);
  }

  override async login(
    encryptedStorage: import('../encryptedStorage.js').EncryptedStorage,
    launchOptions: import('../playwrightUtils.js').BrowserLaunchOptions = {},
    _oldCredentials?: ApiCredentials
  ): Promise<LoginResult> {
    const { withTempBrowserContext } = await import('../playwrightUtils.js');
    const clientId = RAMP_OAUTH_CLIENT_ID;

    return withTempBrowserContext(encryptedStorage, launchOptions, async ({ context }) => {
      const page = await context.newPage();

      const abortController = new AbortController();
      const closeHandler = () => {
        abortController.abort();
      };
      page.on('close', closeHandler);
      context.on('close', closeHandler);

      try {
        // 1. Stand up the localhost callback server (random port; Ramp's public
        //    client allows arbitrary loopback ports per RFC 8252).
        const { port, codePromise } = await startOAuthCallbackServer(
          RAMP_LOGIN_TIMEOUT_MS,
          abortController.signal,
          RAMP_OAUTH_CALLBACK_PATH
        );
        const redirectUri = `http://localhost:${port.toString()}${RAMP_OAUTH_CALLBACK_PATH}`;

        // 2. PKCE verifier/challenge.
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);

        // 3. Open Ramp's hosted authorize screen. auth_level=auto triggers the
        //    "create/approve an AI agent key" prompt.
        const authUrl = new URL(RAMP_AUTHORIZE_URL);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('client_id', clientId);
        authUrl.searchParams.set('redirect_uri', redirectUri);
        authUrl.searchParams.set('scope', RAMP_OAUTH_SCOPES);
        authUrl.searchParams.set('state', randomUUID());
        authUrl.searchParams.set('code_challenge', codeChallenge);
        authUrl.searchParams.set('code_challenge_method', 'S256');
        authUrl.searchParams.set('auth_level', 'auto');

        await page.goto(authUrl.toString());

        // 4. Wait for the user to finish and the callback to deliver the code.
        const code = await codePromise;

        // 5. Exchange the code for tokens (public client: no secret).
        const tokens = exchangeCodeForTokens(
          RAMP_PKCE_TOKEN_ENDPOINT,
          code,
          clientId,
          '',
          redirectUri,
          codeVerifier
        );
        const accessTokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

        await page.close();

        // Public client: clientSecret is stored as '' so refresh sends client_id only.
        const credentials = new OAuthCredentials(
          clientId,
          '',
          tokens.access_token,
          tokens.refresh_token,
          accessTokenExpiresAt
        );
        const account = (await this.service.determineAccount(credentials)) ?? DEFAULT_ACCOUNT;
        return { credentials, account };
      } catch (error: unknown) {
        if (error instanceof Error && isBrowserClosedError(error)) {
          throw new LoginCancelledError();
        }
        throw error;
      } finally {
        page.off('close', closeHandler);
        context.off('close', closeHandler);
      }
    });
  }
}

export class Ramp extends Service {
  readonly name = 'ramp';
  readonly displayName = 'Ramp';
  readonly baseApiUrls = ['https://api.ramp.com/'] as const;
  readonly loginUrl = 'https://app.ramp.com/';
  readonly info =
    'Ramp agent-tools API; the REST API is not supported. ' +
    'Docs: https://api.ramp.com/v1/public/agent-tools/spec/.';

  // Validate credentials against `search-help-center-snippets`: the one agent-tools
  // endpoint that requires only a valid token and no specific scope (`security:
  // [{oauth2: []}]` in the spec), so the check works regardless of which scopes the
  // signed-in user's agent key was granted. It's a POST taking a required
  // {query, rationale} body; a bad token returns a non-200 (404 DEVELOPER_7002).
  readonly credentialCheckCurlArguments = [
    '-X',
    'POST',
    '-H',
    'Content-Type: application/json',
    '-d',
    '{"query":"ping","rationale":"latchkey credential check"}',
    'https://api.ramp.com/developer/v1/agent-tools/search-help-center-snippets',
  ] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth browser ${serviceName}`;
  }

  /**
   * The credential-check endpoint carries no identity, so the account comes
   * from a separate call to `get-simplified-user-detail` — the agent-tools
   * endpoint that returns the caller's user. Best-effort: it needs the
   * `users:read` scope (requested during login, but granted only if the
   * signed-in user is entitled to it).
   */
  override async determineAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    let curlArguments: readonly string[];
    try {
      curlArguments = await apiCredentials.injectIntoCurlCall([
        '-s',
        '-X',
        'POST',
        '-H',
        'Content-Type: application/json',
        '-d',
        '{"rationale":"latchkey determines which account these credentials belong to"}',
        'https://api.ramp.com/developer/v1/agent-tools/get-simplified-user-detail',
      ]);
    } catch (error) {
      if (error instanceof ApiCredentialsUsageError) {
        return null;
      }
      throw error;
    }
    const result = runCaptured(curlArguments, 10);
    const data = tryParseJson(result.stdout) as {
      users?: readonly { email?: string; id?: string }[];
    } | null;
    const user = data?.users?.[0];
    return user?.email ?? user?.id ?? null;
  }

  /**
   * Browser login: run the OAuth authorization-code + PKCE flow and store the
   * resulting bearer + refresh token.
   */
  override getSession(appNamePrefix: string): RampOAuthServiceSession {
    return new RampOAuthServiceSession(this, appNamePrefix);
  }

  override refreshCredentials(apiCredentials: ApiCredentials): Promise<ApiCredentials | null> {
    // Refresh the PKCE access token with the (rotating) refresh token against the
    // `/token/pkce` endpoint, mirroring ramp-cli.
    if (!(apiCredentials instanceof OAuthCredentials)) {
      return Promise.resolve(null);
    }
    if (apiCredentials.refreshToken === undefined || apiCredentials.refreshToken === '') {
      return Promise.resolve(null);
    }
    const tokens = refreshAccessToken(
      RAMP_PKCE_TOKEN_ENDPOINT,
      apiCredentials.refreshToken,
      apiCredentials.clientId,
      apiCredentials.clientSecret
    );
    if (tokens === null) {
      return Promise.resolve(null);
    }
    const accessTokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    // Ramp rotates refresh tokens; keep the old one only if none came back.
    return Promise.resolve(
      new OAuthCredentials(
        apiCredentials.clientId,
        apiCredentials.clientSecret,
        tokens.access_token,
        tokens.refresh_token ?? apiCredentials.refreshToken,
        accessTokenExpiresAt,
        apiCredentials.refreshTokenExpiresAt
      )
    );
  }
}

export const RAMP = new Ramp();
