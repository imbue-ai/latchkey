/**
 * Ramp service implementation. Two authentication pathways, both production:
 *
 * 1. Browser login (`latchkey auth browser ramp`): the OAuth 2.0
 *    authorization-code + PKCE flow against Ramp's public client (a fixed client
 *    ID, no secret). The hosted consent screen (auth_level=auto) mints an "AI
 *    agent key"; latchkey catches the loopback callback, exchanges the code for a
 *    bearer + refresh token at `.../developer/v1/token/pkce`, and stores them as
 *    OAuthCredentials (auto-refreshed). Agent keys use the agent-tools endpoints.
 *
 * 2. API client (`latchkey auth set-nocurl ramp <client_id> <client_secret>
 *    <scope> ...`): the OAuth 2.0 client_credentials grant for single-org access.
 *    The user registers an API client in the Ramp dashboard, enables scopes, and
 *    gives latchkey the client ID/secret and those scopes; latchkey mints/refreshes
 *    a bearer token for exactly those scopes. No refresh token in this grant.
 *
 * Every API call targets https://api.ramp.com/developer/v1.
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

/** Client_credentials token endpoint. */
const RAMP_TOKEN_ENDPOINT = 'https://api.ramp.com/developer/v1/token';

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
  scope: string
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
      RAMP_TOKEN_ENDPOINT,
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

/** Ramp's public OAuth client (PKCE, no secret), from ramp-cli. */
const RAMP_OAUTH_CLIENT_ID = 'ramp_id_6pKvd0IR3d8Kuzp82SV6YgpVCZOlz68Px6s3wVsr';

/** Hosted authorize endpoint (where the user signs in / approves the agent key). */
const RAMP_AUTHORIZE_URL = 'https://app.ramp.com/v1/authorize';

/** PKCE token endpoint (code exchange + refresh). Distinct from the `/token` one. */
const RAMP_PKCE_TOKEN_ENDPOINT = 'https://api.ramp.com/developer/v1/token/pkce';

/** Loopback callback path; matches ramp-cli's `/callback`. */
const RAMP_OAUTH_CALLBACK_PATH = '/callback';

/** Time to wait for the user to finish the hosted login + agent-key approval. */
const RAMP_LOGIN_TIMEOUT_MS = 300_000;

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
  ): Promise<ApiCredentials> {
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
  accessToken: z.string().optional(),
  accessTokenExpiresAt: z.string().optional(),
});

export type RampCredentialsData = z.infer<typeof RampCredentialsSchema>;

export class RampCredentials implements ApiCredentials {
  readonly objectType = 'ramp' as const;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scope: string;
  readonly accessToken?: string;
  readonly accessTokenExpiresAt?: string;

  constructor(
    clientId: string,
    clientSecret: string,
    scope: string,
    accessToken?: string,
    accessTokenExpiresAt?: string
  ) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.scope = scope;
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

  /** Return a copy carrying a freshly minted access token. */
  withToken(accessToken: string, accessTokenExpiresAt: string): RampCredentials {
    return new RampCredentials(
      this.clientId,
      this.clientSecret,
      this.scope,
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
      accessToken: this.accessToken,
      accessTokenExpiresAt: this.accessTokenExpiresAt,
    };
  }

  static fromJSON(data: RampCredentialsData): RampCredentials {
    return new RampCredentials(
      data.clientId,
      data.clientSecret,
      data.scope,
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
  readonly baseApiUrls = ['https://api.ramp.com/'] as const;
  readonly loginUrl = 'https://app.ramp.com/';
  readonly info =
    'Ramp developer API. Agent-tools OpenAPI spec: https://api.ramp.com/v1/public/agent-tools/spec/. ' +
    'Sign in with `latchkey auth browser ramp` to mint an AI agent key; agent keys call ' +
    'POST https://api.ramp.com/developer/v1/agent-tools/<tool> with a JSON {"rationale":"..."} body. ' +
    '(An API client can also be stored with `latchkey auth set-nocurl ramp <client_id> <client_secret> <scope> ...`.)';

  // Unused: credentials are validated by minting a token (see checkApiCredentials),
  // which is scope-independent. Kept for documentation of the simplest read call.
  readonly credentialCheckCurlArguments = [
    'https://api.ramp.com/developer/v1/transactions',
  ] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set-nocurl ${serviceName} <client_id> <client_secret> <scope> [scope ...]`;
  }

  override getCredentialsNoCurl(arguments_: readonly string[]): ApiCredentials {
    const positional = arguments_.filter((argument) => argument !== '');
    const [clientId, clientSecret, ...scopes] = positional;
    if (clientId === undefined || clientSecret === undefined || scopes.length === 0) {
      throw new RampCredentialError(
        'Expected: <client_id> <client_secret> <scope> [scope ...]\n' +
          'Pass the scopes you enabled on the Ramp app (Settings -> Developer), space-separated.\n' +
          'Example: latchkey auth set-nocurl ramp <client_id> <client_secret> transactions:read users:read'
      );
    }
    return new RampCredentials(clientId, clientSecret, scopes.join(' '));
  }

  /**
   * Browser login: run the OAuth authorization-code + PKCE flow and store the
   * resulting bearer + refresh token.
   */
  override getSession(appNamePrefix: string): RampOAuthServiceSession {
    return new RampOAuthServiceSession(this, appNamePrefix);
  }

  override refreshCredentials(apiCredentials: ApiCredentials): Promise<ApiCredentials | null> {
    // Browser-login credentials: refresh the PKCE access token with the (rotating)
    // refresh token against the `/token/pkce` endpoint.
    if (apiCredentials instanceof OAuthCredentials) {
      return this.refreshOAuthCredentials(apiCredentials);
    }
    if (!(apiCredentials instanceof RampCredentials)) {
      return Promise.resolve(null);
    }
    const token = requestRampToken(
      apiCredentials.clientId,
      apiCredentials.clientSecret,
      apiCredentials.scope
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

  /**
   * Validate credentials by confirming a token can be minted/refreshed rather than
   * by hitting a specific resource endpoint. Ramp has no scope-free endpoint, so a
   * resource check would force every user to grant one particular scope; minting is
   * the scope-independent source of truth ("can these credentials obtain a token?").
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
