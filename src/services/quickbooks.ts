/**
 * QuickBooks Online service implementation.
 *
 * QuickBooks uses the OAuth 2.0 authorization-code grant. Because Intuit cannot
 * auto-provision an app the way Google Cloud can, the user registers an app on
 * the Intuit Developer portal, adds latchkey's fixed redirect URI to it, and
 * hands latchkey the client ID/secret via `auth set-nocurl`. `auth browser` then
 * runs the consent flow in a real browser and captures the resulting tokens plus
 * the `realmId` (company id) that Intuit returns on the callback.
 *
 * Two QuickBooks-specific wrinkles are handled so callers never have to think
 * about them:
 *   - The redirect URI must be pre-registered, so the local callback server runs
 *     on a fixed port (QUICKBOOKS_CALLBACK_PORT) rather than a random one.
 *   - Every API URL must embed the realmId in its path
 *     (/v3/company/<realmId>/...). latchkey stores the realmId and substitutes it
 *     wherever the caller writes the literal "{realmId}", so an agent can issue
 *     requests without ever having to look the company id up.
 */

import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Response } from 'playwright';
import { z } from 'zod';
import { ApiCredentials, ApiCredentialsUsageError } from '../apiCredentials/base.js';
import { runCaptured } from '../curl.js';
import { OAuthTokenExchangeError, startOAuthCallbackServerForParams } from '../oauthUtils.js';
import {
  Service,
  ServiceSession,
  LoginFailedError,
  LoginCancelledError,
  NoCurlCredentialsNotSupportedError,
  isBrowserClosedError,
} from './core/base.js';

const QUICKBOOKS_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const QUICKBOOKS_TOKEN_ENDPOINT = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QUICKBOOKS_USERINFO_URL = 'https://accounts.platform.intuit.com/v1/openid_connect/userinfo';

// `openid` lets the (scope- and realm-independent) userinfo endpoint serve as the
// credential check; `accounting` grants access to the QuickBooks Online data API.
const QUICKBOOKS_SCOPE = 'com.intuit.quickbooks.accounting openid';

// Intuit requires the exact redirect URI (including port) to be pre-registered on
// the app, so the callback server binds a fixed port instead of a random one. The
// user registers this exact URI in their Intuit Developer app.
const QUICKBOOKS_CALLBACK_PORT = 8765;
const QUICKBOOKS_CALLBACK_PATH = '/callback';
const QUICKBOOKS_REDIRECT_URI = `http://localhost:${QUICKBOOKS_CALLBACK_PORT.toString()}${QUICKBOOKS_CALLBACK_PATH}`;

// Placeholder callers can put in a URL path in place of the company id; latchkey
// substitutes the stored realmId at request time.
const REALM_PLACEHOLDER = '{realmId}';

const LOGIN_TIMEOUT_MS = 300_000;
const EXPIRY_BUFFER_MS = 60_000;

interface QuickBooksTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

function buildBasicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

function parseTokenResponse(stdout: string): QuickBooksTokenResponse | null {
  try {
    const response = JSON.parse(stdout) as Partial<QuickBooksTokenResponse>;
    if (
      typeof response.access_token !== 'string' ||
      typeof response.refresh_token !== 'string' ||
      typeof response.expires_in !== 'number'
    ) {
      return null;
    }
    return {
      access_token: response.access_token,
      refresh_token: response.refresh_token,
      expires_in: response.expires_in,
    };
  } catch {
    return null;
  }
}

/**
 * Exchange an authorization code for tokens. Intuit authenticates the client with
 * an HTTP Basic header (not body parameters), so this can't reuse the generic
 * oauthUtils exchange. Throws on failure.
 */
function exchangeQuickBooksCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string
): QuickBooksTokenResponse {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  }).toString();

  const result = runCaptured(
    [
      '-s',
      '-X',
      'POST',
      '-H',
      `Authorization: ${buildBasicAuthHeader(clientId, clientSecret)}`,
      '-H',
      'Accept: application/json',
      '-H',
      'Content-Type: application/x-www-form-urlencoded',
      '-d',
      body,
      QUICKBOOKS_TOKEN_ENDPOINT,
    ],
    30
  );

  if (result.returncode !== 0) {
    throw new OAuthTokenExchangeError(
      `Failed to exchange authorization code for tokens: ${result.stderr}`
    );
  }
  const tokens = parseTokenResponse(result.stdout);
  if (tokens === null) {
    throw new OAuthTokenExchangeError('QuickBooks token response missing access or refresh token.');
  }
  return tokens;
}

/**
 * Refresh tokens using the (rotating) refresh token. Returns null on failure.
 */
function refreshQuickBooksToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): QuickBooksTokenResponse | null {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }).toString();

  const result = runCaptured(
    [
      '-s',
      '-X',
      'POST',
      '-H',
      `Authorization: ${buildBasicAuthHeader(clientId, clientSecret)}`,
      '-H',
      'Accept: application/json',
      '-H',
      'Content-Type: application/x-www-form-urlencoded',
      '-d',
      body,
      QUICKBOOKS_TOKEN_ENDPOINT,
    ],
    30
  );

  if (result.returncode !== 0) {
    return null;
  }
  return parseTokenResponse(result.stdout);
}

/**
 * QuickBooks Online OAuth credentials.
 *
 * Holds the client ID/secret (always) and, once authorized, the access/refresh
 * tokens and the connected company's realmId. The access token is injected as
 * `Authorization: Bearer`, and any "{realmId}" in the request URL is replaced
 * with the stored company id.
 */
export const QuickBooksCredentialsSchema = z.object({
  objectType: z.literal('quickbooks'),
  clientId: z.string(),
  clientSecret: z.string(),
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  realmId: z.string().optional(),
  accessTokenExpiresAt: z.string().optional(),
});

export type QuickBooksCredentialsData = z.infer<typeof QuickBooksCredentialsSchema>;

export class QuickBooksCredentials implements ApiCredentials {
  readonly objectType = 'quickbooks' as const;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly realmId?: string;
  readonly accessTokenExpiresAt?: string;

  constructor(
    clientId: string,
    clientSecret: string,
    accessToken?: string,
    refreshToken?: string,
    realmId?: string,
    accessTokenExpiresAt?: string
  ) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.realmId = realmId;
    this.accessTokenExpiresAt = accessTokenExpiresAt;
  }

  injectIntoCurlCall(curlArguments: readonly string[]): Promise<readonly string[]> {
    if (this.accessToken === undefined) {
      throw new ApiCredentialsUsageError(
        'QuickBooks credentials are not authorized yet. Run `latchkey auth browser quickbooks` to sign in.'
      );
    }
    const realmId = this.realmId;
    const substituted =
      realmId === undefined
        ? [...curlArguments]
        : curlArguments.map((argument) => argument.split(REALM_PLACEHOLDER).join(realmId));
    return Promise.resolve(['-H', `Authorization: Bearer ${this.accessToken}`, ...substituted]);
  }

  isExpired(): boolean | undefined {
    // Without an access token the credentials need an interactive browser login,
    // not a token refresh, so don't report "expired" (which would trigger refresh).
    if (this.accessToken === undefined || this.accessTokenExpiresAt === undefined) {
      return undefined;
    }
    return Date.now() >= new Date(this.accessTokenExpiresAt).getTime() - EXPIRY_BUFFER_MS;
  }

  /**
   * Return a copy carrying refreshed tokens (the realmId and client credentials
   * are preserved).
   */
  withRefreshedTokens(
    accessToken: string,
    refreshToken: string,
    accessTokenExpiresAt: string
  ): QuickBooksCredentials {
    return new QuickBooksCredentials(
      this.clientId,
      this.clientSecret,
      accessToken,
      refreshToken,
      this.realmId,
      accessTokenExpiresAt
    );
  }

  toJSON(): QuickBooksCredentialsData {
    return {
      objectType: this.objectType,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      realmId: this.realmId,
      accessTokenExpiresAt: this.accessTokenExpiresAt,
    };
  }

  static fromJSON(data: QuickBooksCredentialsData): QuickBooksCredentials {
    return new QuickBooksCredentials(
      data.clientId,
      data.clientSecret,
      data.accessToken,
      data.refreshToken,
      data.realmId,
      data.accessTokenExpiresAt
    );
  }
}

class QuickBooksCredentialError extends NoCurlCredentialsNotSupportedError {
  constructor(message: string) {
    super('quickbooks');
    this.message = message;
    this.name = 'QuickBooksCredentialError';
  }
}

class QuickBooksServiceSession extends ServiceSession {
  onResponse(_response: Response): void {
    // The OAuth callback is delivered to the local HTTP server, not observed as a
    // page response, so nothing to do here.
  }

  protected isLoginComplete(): boolean {
    // Go straight to the OAuth flow; the user interacts with Intuit's hosted
    // consent screen during finalizeCredentials.
    return true;
  }

  protected async finalizeCredentials(
    _browser: Browser,
    context: BrowserContext,
    oldCredentials?: ApiCredentials
  ): Promise<ApiCredentials | null> {
    const page = context.pages()[0];
    if (!page) {
      throw new LoginFailedError('No page available in browser context.');
    }
    if (!(oldCredentials instanceof QuickBooksCredentials)) {
      throw new LoginFailedError(
        'QuickBooks login requires client credentials. Run ' +
          '`latchkey auth set-nocurl quickbooks <client_id> <client_secret>` first.'
      );
    }
    const { clientId, clientSecret } = oldCredentials;

    const abortController = new AbortController();
    const closeHandler = () => {
      abortController.abort();
    };
    page.on('close', closeHandler);
    context.on('close', closeHandler);

    try {
      const { paramsPromise } = await startOAuthCallbackServerForParams(
        LOGIN_TIMEOUT_MS,
        abortController.signal,
        QUICKBOOKS_CALLBACK_PATH,
        QUICKBOOKS_CALLBACK_PORT
      );

      const authUrl = new URL(QUICKBOOKS_AUTHORIZE_URL);
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', QUICKBOOKS_SCOPE);
      authUrl.searchParams.set('redirect_uri', QUICKBOOKS_REDIRECT_URI);
      authUrl.searchParams.set('state', randomUUID());

      await page.goto(authUrl.toString());

      const params = await paramsPromise;
      const code = params.code;
      if (code === undefined || code === '') {
        throw new LoginFailedError('QuickBooks did not return an authorization code.');
      }
      const realmId = params.realmId;
      if (realmId === undefined || realmId === '') {
        throw new LoginFailedError('QuickBooks did not return a realmId (company id).');
      }

      const tokens = exchangeQuickBooksCode(clientId, clientSecret, code, QUICKBOOKS_REDIRECT_URI);
      const accessTokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

      await page.close();

      return new QuickBooksCredentials(
        clientId,
        clientSecret,
        tokens.access_token,
        tokens.refresh_token,
        realmId,
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
  }
}

export class Quickbooks extends Service {
  readonly name = 'quickbooks';
  readonly displayName = 'QuickBooks';
  readonly baseApiUrls = [
    'https://quickbooks.api.intuit.com/',
    'https://sandbox-quickbooks.api.intuit.com/',
  ] as const;
  readonly loginUrl = 'https://quickbooks.intuit.com/';
  readonly info =
    'https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/account. ' +
    'OAuth 2.0 authorization-code flow. Create an app on the Intuit Developer portal, add the ' +
    `redirect URI ${QUICKBOOKS_REDIRECT_URI} to it, then run ` +
    '`latchkey auth set-nocurl quickbooks <client_id> <client_secret>` followed by ' +
    '`latchkey auth browser quickbooks` to sign in. Every API URL must include the company id; ' +
    'write "{realmId}" in the path (e.g. ' +
    'https://quickbooks.api.intuit.com/v3/company/{realmId}/companyinfo/{realmId}) and latchkey ' +
    'fills in the connected company automatically. Use the sandbox-quickbooks.api.intuit.com host ' +
    'for sandbox companies. Pass `-H "Accept: application/json"` to get JSON instead of XML.';

  // The userinfo endpoint validates the token independently of scope, realm, and
  // environment (sandbox vs production), so it works for any authorized credential.
  readonly credentialCheckCurlArguments = [QUICKBOOKS_USERINFO_URL] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set-nocurl ${serviceName} <client_id> <client_secret>`;
  }

  override getCredentialsNoCurl(arguments_: readonly string[]): ApiCredentials {
    const [clientId, clientSecret] = arguments_;
    if (
      arguments_.length !== 2 ||
      clientId === undefined ||
      clientId === '' ||
      clientSecret === undefined ||
      clientSecret === ''
    ) {
      throw new QuickBooksCredentialError(
        'Expected exactly two arguments: the client ID and client secret.\n' +
          'Example: latchkey auth set-nocurl quickbooks <client_id> <client_secret>\n' +
          'Then run `latchkey auth browser quickbooks` to authorize.'
      );
    }
    return new QuickBooksCredentials(clientId, clientSecret);
  }

  override getSession(appNamePrefix: string): QuickBooksServiceSession {
    return new QuickBooksServiceSession(this, appNamePrefix);
  }

  override refreshCredentials(apiCredentials: ApiCredentials): Promise<ApiCredentials | null> {
    if (!(apiCredentials instanceof QuickBooksCredentials) || !apiCredentials.refreshToken) {
      return Promise.resolve(null);
    }
    const tokens = refreshQuickBooksToken(
      apiCredentials.clientId,
      apiCredentials.clientSecret,
      apiCredentials.refreshToken
    );
    if (tokens === null) {
      return Promise.resolve(null);
    }
    const accessTokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    return Promise.resolve(
      apiCredentials.withRefreshedTokens(
        tokens.access_token,
        tokens.refresh_token,
        accessTokenExpiresAt
      )
    );
  }
}

export const QUICKBOOKS = new Quickbooks();
