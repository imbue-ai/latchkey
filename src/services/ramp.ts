/**
 * Ramp service implementation.
 *
 * Two authentication pathways are supported:
 *
 * 1. Browser login (recommended, `latchkey auth browser ramp`). This replicates
 *    the OAuth 2.0 authorization-code + PKCE flow used by Ramp's own official CLI
 *    (ramp-public/ramp-cli, `ramp auth login`). It uses Ramp's PUBLIC OAuth client
 *    (a fixed client ID, no client secret) and opens the user's browser to Ramp's
 *    hosted sign-in/consent screen, which prompts them to create/approve an "AI
 *    agent key". latchkey catches the loopback callback, exchanges the code for a
 *    bearer access token + refresh token at `.../developer/v1/token/pkce`, and
 *    stores them as OAuthCredentials so the token is refreshed automatically. See
 *    the large block comment above RampOAuthServiceSession for what was learned
 *    from ramp-cli and what must be validated against the live flow.
 *
 * 2. API client (`latchkey auth set-nocurl ramp <client_id> <client_secret>
 *    <scope> ...`). This uses the OAuth 2.0 client_credentials grant for
 *    single-organization access. The user registers an API client in the Ramp
 *    dashboard (Settings -> Developer), enables a set of scopes on it, and gives
 *    latchkey the client ID, client secret, and that same set of scopes.
 *
 *    Scopes in Ramp are bound to the app at creation time: a token request may
 *    only ask for scopes the app already has, and asking for anything else fails
 *    with `invalid_scope`. So latchkey requests exactly the scopes the user passes
 *    in -- no more, no less -- which means the minted token can do everything the
 *    app is allowed to do and nothing it isn't. There is no refresh token in this
 *    grant; latchkey simply mints a new token with the stored client credentials
 *    whenever the current one is missing or expired.
 *
 * Both credential types reuse existing serializable credential classes
 * (OAuthCredentials and RampCredentials) so no new credential type has to be
 * registered. Every API call targets https://api.ramp.com/developer/v1 (or the
 * https://demo-api.ramp.com sandbox host).
 */

import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Response } from 'playwright';
import { z } from 'zod';
import {
  ApiCredentials,
  ApiCredentialStatus,
  ApiCredentialsUsageError,
  OAuthCredentials,
} from '../apiCredentials/base.js';
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
  LoginCancelledError,
  NoCurlCredentialsNotSupportedError,
  Service,
  ServiceSession,
} from './core/base.js';

type RampEnvironment = 'production' | 'sandbox';

const RAMP_TOKEN_ENDPOINTS: Record<RampEnvironment, string> = {
  production: 'https://api.ramp.com/developer/v1/token',
  sandbox: 'https://demo-api.ramp.com/developer/v1/token',
};

/**
 * Treat a token as expired this long before its real expiry, so it is never
 * used right at the edge of its lifetime.
 */
const EXPIRY_BUFFER_MS = 60_000;

interface RampTokenResponse {
  access_token: string;
  expires_in: number;
}

/**
 * Mint a fresh access token from Ramp using the client_credentials grant.
 * Returns null if the request fails or the response is malformed.
 */
function requestRampToken(
  clientId: string,
  clientSecret: string,
  scope: string,
  environment: RampEnvironment
): RampTokenResponse | null {
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope,
  }).toString();

  const result = runCaptured(
    [
      '-s',
      '-X',
      'POST',
      '-H',
      `Authorization: Basic ${basicAuth}`,
      '-H',
      'Content-Type: application/x-www-form-urlencoded',
      '-d',
      body,
      RAMP_TOKEN_ENDPOINTS[environment],
    ],
    30
  );

  if (result.returncode !== 0) {
    return null;
  }

  try {
    const response = JSON.parse(result.stdout) as Partial<RampTokenResponse>;
    if (typeof response.access_token !== 'string' || typeof response.expires_in !== 'number') {
      return null;
    }
    return { access_token: response.access_token, expires_in: response.expires_in };
  } catch {
    return null;
  }
}

// ===========================================================================
// Browser login (OAuth 2.0 authorization-code + PKCE) -- mirrors ramp-cli.
// ===========================================================================
//
// What ramp-cli does (learned from github.com/ramp-public/ramp-cli, the official
// CLI; primarily src/ramp_cli/auth/oauth.py and src/ramp_cli/config/constants.py):
//
//   - `ramp auth login` runs a standard OAuth 2.0 authorization-code flow with
//     PKCE (RFC 7636) against a *public* client (a fixed client ID baked into the
//     CLI, NO client secret; token_endpoint_auth_method = "none").
//   - It opens the system browser to Ramp's hosted authorize URL. With
//     `auth_level=auto`, Ramp's consent screen prompts the user to create/approve
//     an "AI agent key" tied to their login -- this is the agent-key pathway.
//   - It runs a tiny localhost HTTP server to catch the `?code=...` redirect. It
//     prefers a fixed port (19817) but falls back to a random port, which means
//     Ramp's public client allows arbitrary loopback redirect URIs (RFC 8252), so
//     latchkey can safely use a random port via startOAuthCallbackServer().
//   - It exchanges the code at `.../developer/v1/token/pkce` (note the `/pkce`
//     suffix; different from the client_credentials `/token` endpoint above),
//     sending client_id + code + redirect_uri + code_verifier in the form body.
//   - The response is a bearer access token (a JWT; agent-key sessions carry an
//     `ak` claim) plus a refresh token. ramp-cli stores both and silently
//     refreshes (src/ramp_cli/auth/refresh.py) using grant_type=refresh_token.
//   - All Developer-API calls then use `Authorization: Bearer <access_token>`
//     against https://api.ramp.com/developer/v1 (or the demo-api sandbox host).
//
// latchkey reproduces exactly this flow below, driving the browser step through
// Playwright (withTempBrowserContext) instead of `open(url)`, and storing the
// result as OAuthCredentials (which already holds access+refresh tokens and is
// auto-refreshed by src/apiCredentials/utils.ts). Because the user drives Ramp's
// own hosted login/consent UI, there are NO scraped selectors in the happy path
// -- the only Ramp-specific contract is the set of URLs/IDs/scopes constants and
// the loopback callback shape.
//
// !!! MUST BE VALIDATED AGAINST THE LIVE FLOW !!!
// This was implemented from ramp-cli's source without a live Ramp account, so the
// following have NOT been exercised end-to-end and must be confirmed by recording
// a real login (see scripts/recordBrowserSession.ts / scripts/codegen.ts and the
// "Adding a new service" section of docs/development.md):
//   1. The public client IDs, authorize URLs, and `/token/pkce` endpoints below
//      still match ramp-cli (re-check config/constants.py if login fails).
//   2. Ramp accepts a random-port `http://localhost:<port>/callback` redirect URI
//      for the public client (expected per RFC 8252, since ramp-cli falls back to
//      a random port). If not, pin RAMP_OAUTH_CALLBACK_PORT to 19817.
//   3. The requested scopes are all valid for the public client; if the authorize
//      step fails with `invalid_scope`, trim RAMP_OAUTH_SCOPES to the subset Ramp
//      accepts (the granted scopes come back in the token response's `scope`).
//   4. `auth_level=auto` surfaces the "create AI agent key" prompt as expected.

type RampEnvironmentRecord = Record<RampEnvironment, string>;

/** Ramp's public OAuth client IDs (PKCE, no secret), copied from ramp-cli. */
const RAMP_OAUTH_CLIENT_IDS: RampEnvironmentRecord = {
  production: 'ramp_id_6pKvd0IR3d8Kuzp82SV6YgpVCZOlz68Px6s3wVsr',
  sandbox: 'ramp_id_Q0xnopBQxMjvXzmA04GkhA9LQqbT3XwYdrHoJRTI',
};

/** Hosted authorize endpoints (where the user signs in / approves the agent key). */
const RAMP_AUTHORIZE_URLS: RampEnvironmentRecord = {
  production: 'https://app.ramp.com/v1/authorize',
  sandbox: 'https://demo.ramp.com/v1/authorize',
};

/** PKCE token endpoints (code exchange + refresh). Distinct from the `/token` one. */
const RAMP_PKCE_TOKEN_ENDPOINTS: RampEnvironmentRecord = {
  production: 'https://api.ramp.com/developer/v1/token/pkce',
  sandbox: 'https://demo-api.ramp.com/developer/v1/token/pkce',
};

/** Loopback callback path; matches ramp-cli's `/callback`. */
const RAMP_OAUTH_CALLBACK_PATH = '/callback';

/** Time to wait for the user to finish the hosted login + agent-key approval. */
const RAMP_LOGIN_TIMEOUT_MS = 300_000;

/**
 * Scopes requested at login for the agent-key (auth_level=auto) flow.
 *
 * We request the UNION of ramp-cli's standard DEVAPI_SCOPES and Ramp's agentic
 * scope catalog, so one token can serve BOTH Ramp API surfaces:
 *   - the standard REST endpoints (e.g. GET /developer/v1/cards) need standard
 *     scopes like `cards:read`, while
 *   - the agent-tool endpoints (e.g. POST /developer/v1/agent-tools/list-cards)
 *     need the agentic scopes like `cards:read_agentic` and `limits:read`.
 * Cards is the only resource whose read scope differs by surface (`cards:read`
 * vs `cards:read_agentic`), so both are listed; every other resource shares one
 * scope name across surfaces. Requesting a scope the signed-in user isn't
 * entitled to is harmless -- Ramp grants only the subset the user has and
 * returns it in the token's `scope` field. But OMITTING a scope an endpoint
 * needs fails at call time with
 *   DEVELOPER_7100: "These scopes are not allowed for this token: <scope>".
 * VERIFIED 2026-06-23: a browser/agent-key credential (auth_level=auto) is
 * auth-LEVEL barred from the standard REST endpoints -- GET /developer/v1/cards
 * returns HTTP 403 "Authorization level not allowed" (DEVELOPER_7077) no matter
 * what scopes the token carries -- while POST /developer/v1/agent-tools/list-cards
 * returns 200. So for the agent-key flow only the agentic scopes are ever
 * usable; the standard `cards:read`/`bills:write` here are inert for agent keys
 * and kept only so the requested set stays a superset (harmless -- Ramp grants
 * the entitled subset). Agents MUST use the agent-tools endpoints; see `info`.
 */
const RAMP_OAUTH_SCOPES = [
  'accounting:read',
  'approvals:write',
  'bills:read',
  'bills:write',
  'business:read',
  'cards:read',
  'cards:read_agentic',
  'cards:write',
  'cashbacks:read',
  'comments:write',
  'departments:read',
  'departments:write',
  'entities:read',
  'funds:write',
  'item_receipts:read',
  'limits:read',
  'limits:write',
  'locations:read',
  'locations:write',
  'memos:read',
  'merchants:read',
  'purchase_orders:read',
  'purchase_orders:write',
  'receipts:read',
  'receipts:write',
  'reimbursements:read',
  'reimbursements:write',
  'spend_programs:read',
  'spend_programs:write',
  'statements:read',
  'tasks:read',
  'transactions:read',
  'transactions:write',
  'transfers:read',
  'treasury:read',
  'trips:read',
  'trips:write',
  'unified_requests:read',
  'users:read',
  'users:write',
  'vendors:read',
  'vendors:write',
].join(' ');

/**
 * Recover which environment a stored OAuthCredentials belongs to from its client
 * ID. OAuthCredentials carries no environment field, but the public client IDs are
 * environment-specific, so the ID alone is enough to pick the right token endpoint
 * when refreshing. Anything that isn't the sandbox client is treated as production.
 */
function rampOAuthEnvironmentForClientId(clientId: string): RampEnvironment {
  return clientId === RAMP_OAUTH_CLIENT_IDS.sandbox ? 'sandbox' : 'production';
}

/**
 * Browser login session: runs the ramp-cli OAuth authorization-code + PKCE flow in
 * a Playwright browser and returns OAuthCredentials. login() is overridden wholesale
 * (the base template's static loginUrl + response-watching model doesn't fit a
 * per-session authorize URL with a localhost callback), mirroring NotionMcpSession.
 */
class RampOAuthServiceSession extends ServiceSession {
  private readonly environment: RampEnvironment;

  constructor(service: Service, appNamePrefix: string, environment: RampEnvironment) {
    super(service, appNamePrefix);
    this.environment = environment;
  }

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
  ): Promise<ApiCredentials> {
    const { withTempBrowserContext } = await import('../playwrightUtils.js');
    const environment = this.environment;
    const clientId = RAMP_OAUTH_CLIENT_IDS[environment];

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
        //    client allows arbitrary loopback ports, see validation note #2).
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
        const authUrl = new URL(RAMP_AUTHORIZE_URLS[environment]);
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
          RAMP_PKCE_TOKEN_ENDPOINTS[environment],
          code,
          clientId,
          '',
          redirectUri,
          codeVerifier
        );
        const accessTokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

        await page.close();

        // Public client: clientSecret is stored as '' so refresh sends client_id only.
        return new OAuthCredentials(
          clientId,
          '',
          tokens.access_token,
          tokens.refresh_token,
          accessTokenExpiresAt
        );
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

/**
 * Ramp OAuth client_credentials credentials.
 *
 * Stores the client ID/secret and the exact scopes the app was granted (used to
 * mint tokens) plus the most recently minted access token. The token is injected
 * as `Authorization: Bearer`.
 */
export const RampCredentialsSchema = z.object({
  objectType: z.literal('ramp'),
  clientId: z.string(),
  clientSecret: z.string(),
  scope: z.string(),
  environment: z.enum(['production', 'sandbox']),
  accessToken: z.string().optional(),
  accessTokenExpiresAt: z.string().optional(),
});

export type RampCredentialsData = z.infer<typeof RampCredentialsSchema>;

export class RampCredentials implements ApiCredentials {
  readonly objectType = 'ramp' as const;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scope: string;
  readonly environment: RampEnvironment;
  readonly accessToken?: string;
  readonly accessTokenExpiresAt?: string;

  constructor(
    clientId: string,
    clientSecret: string,
    scope: string,
    environment: RampEnvironment,
    accessToken?: string,
    accessTokenExpiresAt?: string
  ) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.scope = scope;
    this.environment = environment;
    this.accessToken = accessToken;
    this.accessTokenExpiresAt = accessTokenExpiresAt;
  }

  injectIntoCurlCall(curlArguments: readonly string[]): Promise<readonly string[]> {
    if (this.accessToken === undefined) {
      throw new ApiCredentialsUsageError(
        'Ramp credentials have no access token yet. A token is minted automatically on use; ' +
          'if you see this, re-run the command or re-set the credentials.'
      );
    }
    return Promise.resolve(['-H', `Authorization: Bearer ${this.accessToken}`, ...curlArguments]);
  }

  isExpired(): boolean | undefined {
    // No token yet (only client ID/secret stored): report expired so the refresh
    // path mints the first token before the request goes out.
    if (this.accessToken === undefined) {
      return true;
    }
    if (this.accessTokenExpiresAt === undefined) {
      return undefined;
    }
    return Date.now() >= new Date(this.accessTokenExpiresAt).getTime() - EXPIRY_BUFFER_MS;
  }

  /**
   * Return a copy carrying a freshly minted access token.
   */
  withToken(accessToken: string, accessTokenExpiresAt: string): RampCredentials {
    return new RampCredentials(
      this.clientId,
      this.clientSecret,
      this.scope,
      this.environment,
      accessToken,
      accessTokenExpiresAt
    );
  }

  toJSON(): RampCredentialsData {
    return {
      objectType: this.objectType,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      scope: this.scope,
      environment: this.environment,
      accessToken: this.accessToken,
      accessTokenExpiresAt: this.accessTokenExpiresAt,
    };
  }

  static fromJSON(data: RampCredentialsData): RampCredentials {
    return new RampCredentials(
      data.clientId,
      data.clientSecret,
      data.scope,
      data.environment,
      data.accessToken,
      data.accessTokenExpiresAt
    );
  }
}

class RampCredentialError extends NoCurlCredentialsNotSupportedError {
  constructor(message: string) {
    super('ramp');
    this.message = message;
    this.name = 'RampCredentialError';
  }
}

export class Ramp extends Service {
  readonly name = 'ramp';
  readonly displayName = 'Ramp';
  // Both the production and sandbox (demo) hosts route here; the stored
  // credential records which environment it was issued for.
  readonly baseApiUrls = ['https://api.ramp.com/', 'https://demo-api.ramp.com/'] as const;
  readonly loginUrl = 'https://app.ramp.com/';
  readonly info =
    'https://docs.ramp.com/developer-api/v1/overview. Base host https://api.ramp.com/developer/v1 ' +
    '(demo-api.ramp.com for sandbox). IMPORTANT: Ramp has TWO API surfaces, and which one you may ' +
    'use is determined by how the credential was created -- pick endpoints accordingly: ' +
    '(A) Browser/agent-key login (the `latchkey auth browser ramp` flow, auth_level=auto): you can ' +
    'ONLY use the AGENT-TOOLS endpoints -- POST https://api.ramp.com/developer/v1/agent-tools/<tool> ' +
    'with a JSON body {"rationale":"<why you are making this call>"} (e.g. agent-tools/list-cards, ' +
    'agent-tools/list-transactions). The standard REST endpoints (e.g. GET /developer/v1/cards) reject ' +
    'agent keys with HTTP 403 "Authorization level not allowed" (DEVELOPER_7077) regardless of scopes, ' +
    'so do NOT use them with a browser/agent-key credential. ' +
    '(B) API client (client_credentials, stored via `latchkey auth set-nocurl`): use the STANDARD REST ' +
    'endpoints (GET /developer/v1/cards, /transactions, ...) with the scopes you enabled on the app. ' +
    'Two ways to authenticate: ' +
    '(1) Browser login (recommended): run `latchkey auth browser ramp`. This runs the same ' +
    "OAuth 2.0 authorization-code + PKCE flow as Ramp's official CLI (ramp-cli `ramp auth login`) " +
    "using Ramp's public client, opens Ramp's hosted sign-in/consent screen (which prompts you to " +
    'create/approve an AI agent key), and stores the resulting bearer + refresh token, refreshing ' +
    'automatically. Targets production. Use the agent-tools endpoints (surface A) with this credential. ' +
    '(2) API client (client_credentials): in the Ramp dashboard, register an API client under ' +
    'Settings -> Developer and enable the scopes you want it to have, then store it with ' +
    '`latchkey auth set-nocurl ramp <client_id> <client_secret> <scope> [scope ...]`, passing ' +
    'the same scopes you enabled on the app (e.g. transactions:read users:read). Latchkey ' +
    'requests exactly those scopes and mints/refreshes the bearer token automatically, so the ' +
    'token can do everything the app is allowed to do and nothing more. Add `--sandbox` to use ' +
    'the demo environment (https://demo-api.ramp.com).';

  // Unused: credentials are validated by minting a token (see checkApiCredentials),
  // which is scope-independent. Kept for documentation of the simplest read call.
  readonly credentialCheckCurlArguments = [
    'https://api.ramp.com/developer/v1/transactions',
  ] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set-nocurl ${serviceName} <client_id> <client_secret> <scope> [scope ...]`;
  }

  override getCredentialsNoCurl(arguments_: readonly string[]): ApiCredentials {
    let environment: RampEnvironment = 'production';
    const positional: string[] = [];
    for (const argument of arguments_) {
      if (argument === '--sandbox' || argument === 'sandbox') {
        environment = 'sandbox';
      } else if (argument === '--production' || argument === 'production') {
        environment = 'production';
      } else if (argument !== '') {
        positional.push(argument);
      }
    }

    const [clientId, clientSecret, ...scopes] = positional;
    if (clientId === undefined || clientSecret === undefined || scopes.length === 0) {
      throw new RampCredentialError(
        'Expected: <client_id> <client_secret> <scope> [scope ...]\n' +
          'Pass the scopes you enabled on the Ramp app (Settings -> Developer), space-separated.\n' +
          'Example: latchkey auth set-nocurl ramp <client_id> <client_secret> transactions:read users:read'
      );
    }
    return new RampCredentials(clientId, clientSecret, scopes.join(' '), environment);
  }

  /**
   * Browser login: run the ramp-cli OAuth authorization-code + PKCE flow and store
   * the resulting bearer + refresh token. Always targets production -- the standard
   * `auth browser` command can't pass an environment, and the sandbox is served by
   * the existing client_credentials (`set-nocurl ... --sandbox`) pathway instead.
   */
  override getSession(appNamePrefix: string): RampOAuthServiceSession {
    return new RampOAuthServiceSession(this, appNamePrefix, 'production');
  }

  override refreshCredentials(apiCredentials: ApiCredentials): Promise<ApiCredentials | null> {
    // Browser-login credentials: refresh the PKCE access token with the (rotating)
    // refresh token against the `/token/pkce` endpoint, mirroring ramp-cli.
    if (apiCredentials instanceof OAuthCredentials) {
      return this.refreshOAuthCredentials(apiCredentials);
    }
    if (!(apiCredentials instanceof RampCredentials)) {
      return Promise.resolve(null);
    }
    const token = requestRampToken(
      apiCredentials.clientId,
      apiCredentials.clientSecret,
      apiCredentials.scope,
      apiCredentials.environment
    );
    if (token === null) {
      return Promise.resolve(null);
    }
    const accessTokenExpiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();
    return Promise.resolve(apiCredentials.withToken(token.access_token, accessTokenExpiresAt));
  }

  private refreshOAuthCredentials(
    apiCredentials: OAuthCredentials
  ): Promise<ApiCredentials | null> {
    if (apiCredentials.refreshToken === undefined || apiCredentials.refreshToken === '') {
      return Promise.resolve(null);
    }
    const environment = rampOAuthEnvironmentForClientId(apiCredentials.clientId);
    const tokens = refreshAccessToken(
      RAMP_PKCE_TOKEN_ENDPOINTS[environment],
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

  /**
   * Validate credentials by confirming a token can be minted, rather than by
   * hitting a specific resource endpoint. Ramp has no scope-free endpoint, so a
   * resource check would force every user to grant one particular scope; minting
   * is the scope-independent source of truth ("can these client credentials
   * obtain a token for their scopes?").
   *
   * The refresh path runs before this and mints a token when needed, so in the
   * common case we just confirm the (already refreshed) credentials hold a live
   * token; we mint here only as a fallback when they don't.
   *
   * Browser-login (OAuthCredentials) credentials are validated the same way: we
   * treat "holds a live access token, or can refresh one" as valid. This is also
   * environment-agnostic (it avoids hitting a hardcoded prod-vs-sandbox endpoint
   * with a token issued for the other host).
   */
  override async checkApiCredentials(apiCredentials: ApiCredentials): Promise<ApiCredentialStatus> {
    if (apiCredentials instanceof OAuthCredentials) {
      return this.checkOAuthCredentials(apiCredentials);
    }
    if (!(apiCredentials instanceof RampCredentials)) {
      return ApiCredentialStatus.Missing;
    }
    let credentials: RampCredentials | null = apiCredentials;
    if (credentials.isExpired() === true) {
      const refreshed = await this.refreshCredentials(apiCredentials);
      credentials = refreshed instanceof RampCredentials ? refreshed : null;
    }
    if (credentials?.accessToken === undefined) {
      return ApiCredentialStatus.Invalid;
    }
    return credentials.isExpired() === true
      ? ApiCredentialStatus.Invalid
      : ApiCredentialStatus.Valid;
  }

  private async checkOAuthCredentials(
    apiCredentials: OAuthCredentials
  ): Promise<ApiCredentialStatus> {
    let credentials: OAuthCredentials | null = apiCredentials;
    if (credentials.isExpired() === true) {
      const refreshed = await this.refreshCredentials(apiCredentials);
      credentials = refreshed instanceof OAuthCredentials ? refreshed : null;
    }
    if (credentials?.accessToken === undefined) {
      return ApiCredentialStatus.Invalid;
    }
    return credentials.isExpired() === true
      ? ApiCredentialStatus.Invalid
      : ApiCredentialStatus.Valid;
  }
}

export const RAMP = new Ramp();
