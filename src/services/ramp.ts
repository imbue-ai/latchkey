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
import { ApiCredentials, OAuthCredentials } from '../apiCredentials/base.js';
import {
  DEFAULT_ACCOUNT,
  fetchAccountFromEndpoint,
  tryParseJson,
} from '../apiCredentials/account.js';
import {
  buildLoopbackRedirectUri,
  exchangeCodeForTokens,
  generateCodeChallenge,
  generateCodeVerifier,
  refreshAccessToken,
  startOAuthCallbackServer,
} from '../oauthUtils.js';
import type { EncryptedStorage } from '../encryptedStorage.js';
import type { BrowserLaunchOptions } from '../playwrightUtils.js';
import { type LoginOptions, type LoginResult, Service, ServiceSession } from './core/base.js';
import { withOAuthLoginBrowser } from './core/oauthLoginBrowser.js';

/** Ramp's public OAuth client (PKCE, no secret), from ramp-cli. */
const RAMP_OAUTH_CLIENT_ID = 'ramp_id_6pKvd0IR3d8Kuzp82SV6YgpVCZOlz68Px6s3wVsr';

/** Hosted authorize endpoint (where the user signs in / approves the agent key). */
const RAMP_AUTHORIZE_URL = 'https://app.ramp.com/v1/authorize';

/** PKCE token endpoint (code exchange + refresh). */
const RAMP_PKCE_TOKEN_ENDPOINT = 'https://api.ramp.com/developer/v1/token/pkce';

/** Loopback callback path; matches ramp-cli's `/callback`. */
const RAMP_OAUTH_CALLBACK_PATH = '/callback';

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
 * Browser login session: runs the OAuth authorization-code + PKCE flow in the
 * browser `withOAuthLoginBrowser` provides and returns OAuthCredentials. login()
 * is overridden wholesale (the base template's static loginUrl +
 * response-watching model doesn't fit a per-session authorize URL with a
 * localhost callback), mirroring RemoteMcpSession.
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

  override readonly supportsSystemBrowser = true;

  override async login(
    encryptedStorage: EncryptedStorage,
    launchOptions: BrowserLaunchOptions = {},
    _oldCredentials?: ApiCredentials,
    loginOptions: LoginOptions = {}
  ): Promise<LoginResult> {
    const clientId = RAMP_OAUTH_CLIENT_ID;

    return withOAuthLoginBrowser(encryptedStorage, launchOptions, loginOptions, async (browser) => {
      // 1. Stand up the localhost callback server (random port; Ramp's public
      //    client allows arbitrary loopback ports per RFC 8252).
      const { port, codePromise } = await startOAuthCallbackServer(
        browser.closeSignal,
        RAMP_OAUTH_CALLBACK_PATH
      );
      const redirectUri = buildLoopbackRedirectUri(port, RAMP_OAUTH_CALLBACK_PATH);

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

      await browser.open(authUrl.toString());

      // 4. Wait for the user to finish and the callback to deliver the code.
      const code = await codePromise;

      // 5. Exchange the code for tokens (public client: no secret).
      const tokens = await exchangeCodeForTokens(
        RAMP_PKCE_TOKEN_ENDPOINT,
        code,
        clientId,
        '',
        redirectUri,
        codeVerifier
      );
      const accessTokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

      // Public client: clientSecret is stored as '' so refresh sends client_id only.
      const credentials = new OAuthCredentials(
        clientId,
        '',
        tokens.access_token,
        tokens.refresh_token,
        accessTokenExpiresAt
      );
      const account = (await this.service.getAccount?.(credentials)) ?? DEFAULT_ACCOUNT;
      return { credentials, account };
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
   * The account comes from `get-simplified-user-detail` — the agent-tools
   * endpoint that returns the caller's user — rather than the scope-less
   * help-center endpoint used by the credential check, which carries no
   * identity. It needs the `users:read` scope (requested during login, but
   * granted only if the signed-in user is entitled to it), so the account may
   * stay undetermined.
   */
  override getAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    return fetchAccountFromEndpoint(
      apiCredentials,
      [
        '-X',
        'POST',
        '-H',
        'Content-Type: application/json',
        '-d',
        '{"rationale":"latchkey determines which account these credentials belong to"}',
        'https://api.ramp.com/developer/v1/agent-tools/get-simplified-user-detail',
      ],
      (responseBody) => {
        const data = tryParseJson(responseBody) as {
          users?: readonly { email?: string; id?: string }[];
        } | null;
        const user = data?.users?.[0];
        return user?.email ?? user?.id ?? null;
      }
    );
  }

  /**
   * Browser login: run the OAuth authorization-code + PKCE flow and store the
   * resulting bearer + refresh token.
   */
  override getSession(appNamePrefix: string): RampOAuthServiceSession {
    return new RampOAuthServiceSession(this, appNamePrefix);
  }

  override async refreshCredentials(
    apiCredentials: ApiCredentials
  ): Promise<ApiCredentials | null> {
    // Refresh the PKCE access token with the (rotating) refresh token against the
    // `/token/pkce` endpoint, mirroring ramp-cli.
    if (!(apiCredentials instanceof OAuthCredentials)) {
      return null;
    }
    if (apiCredentials.refreshToken === undefined || apiCredentials.refreshToken === '') {
      return null;
    }
    const tokens = await refreshAccessToken(
      RAMP_PKCE_TOKEN_ENDPOINT,
      apiCredentials.refreshToken,
      apiCredentials.clientId,
      apiCredentials.clientSecret
    );
    if (tokens === null) {
      return null;
    }
    const accessTokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    // Ramp rotates refresh tokens; keep the old one only if none came back.
    return new OAuthCredentials(
      apiCredentials.clientId,
      apiCredentials.clientSecret,
      tokens.access_token,
      tokens.refresh_token ?? apiCredentials.refreshToken,
      accessTokenExpiresAt,
      apiCredentials.refreshTokenExpiresAt
    );
  }
}

export const RAMP = new Ramp();
