/**
 * Fastmail service implementation.
 *
 * Fastmail's JMAP API is an OAuth 2.1 protected resource: it advertises an
 * authorization server at `https://api.fastmail.com` (RFC 8414 metadata at
 * `/.well-known/oauth-authorization-server`) supporting dynamic client
 * registration, PKCE (S256) and refresh tokens, with public clients
 * (`token_endpoint_auth_method: none`). So no API token has to be created by
 * hand in the account's settings and pasted in — `latchkey auth browser
 * fastmail` is enough.
 */

import { z } from 'zod';
import type { Browser, BrowserContext, Response } from 'playwright';
import { type ApiCredentials, OAuthCredentials } from '../apiCredentials/base.js';
import {
  DEFAULT_ACCOUNT,
  fetchAccountFromEndpoint,
  tryParseJson,
} from '../apiCredentials/account.js';
import { runCapturedAsync } from '../curl.js';
import {
  exchangeCodeForTokens,
  generateCodeChallenge,
  generateCodeVerifier,
  refreshAccessToken,
  startOAuthCallbackServer,
} from '../oauthUtils.js';
import {
  Service,
  ServiceSession,
  type LoginResult,
  LoginFailedError,
  LoginCancelledError,
  buildPreparedCredentials,
  isBrowserClosedError,
} from './core/base.js';

/**
 * JSON accepted by `latchkey auth prepare fastmail`: an OAuth client id to
 * reuse instead of registering a new client dynamically. Fastmail issues
 * public clients, so no secret is needed. `.strict()` rejects unknown keys so
 * typos are reported instead of silently ignored.
 */
export const FastmailPrepareInputSchema = z
  .object({
    clientId: z.string().min(1),
  })
  .strict();

export type FastmailPrepareInput = z.infer<typeof FastmailPrepareInputSchema>;

const SESSION_ENDPOINT = 'https://api.fastmail.com/jmap/session';
const REGISTRATION_ENDPOINT = 'https://api.fastmail.com/oauth/register';
const AUTHORIZATION_ENDPOINT = 'https://api.fastmail.com/oauth/authorize';
// Named `/oauth/refresh` rather than `/oauth/token`, but this is the
// `token_endpoint` of Fastmail's authorization server metadata: it serves both
// the authorization_code exchange and the refresh_token grant.
const TOKEN_ENDPOINT = 'https://api.fastmail.com/oauth/refresh';

/**
 * RFC 8707 resource indicator, required by Fastmail: an authorization request
 * that does not name the resource it is for is refused with `invalid_target`.
 * This is the `resource` of the protected-resource metadata at
 * `/.well-known/oauth-protected-resource/jmap/session`, and it is what scopes
 * the JMAP capabilities to. Fastmail publishes a second, unrelated resource for
 * its MCP endpoint (`https://api.fastmail.com/mcp`) with its own scope; naming
 * the wrong one here would yield tokens JMAP will not accept.
 */
const JMAP_RESOURCE = 'https://api.fastmail.com/jmap/session';

/**
 * One service carries all three JMAP scopes rather than splitting into
 * per-capability services the way the Google ones do. Google's products are
 * separate APIs on separate hosts, so a service each disambiguates cleanly;
 * Fastmail's are one JMAP session behind one host, so sibling services would
 * all match the same URLs and a request could pick whichever credential
 * happened to be registered first — including one lacking the needed scope.
 *
 * Mail plus a refresh token. Fastmail also offers `…scope:contacts` and
 * `…scope:calendars`, which JMAP exposes through the same session document —
 * add them here if latchkey grows callers that need those capabilities, but
 * asking for them today would over-request on the consent screen.
 *
 * These are the names the authorization server's own metadata advertises, and
 * the only ones its registration endpoint accepts. Fastmail's developer docs
 * list a different set (`urn:ietf:params:jmap:core`, `urn:ietf:params:jmap:mail`,
 * …) which apply to clients registered by hand with Fastmail's partnerships
 * team; passing those to dynamic registration fails outright.
 *
 * The same string is sent twice: once when registering the client, and again on
 * the authorization request. They have to agree — see {@link registerClient}.
 */
const OAUTH_SCOPES =
  'urn:ietf:params:oauth:scope:mail ' +
  'urn:ietf:params:oauth:scope:contacts ' +
  'urn:ietf:params:oauth:scope:calendars ' +
  'offline_access';

const LOGIN_TIMEOUT_MS = 120000;

interface RegistrationResponse {
  client_id: string;
  client_name?: string;
}

/**
 * Register a public OAuth client via RFC 7591 dynamic client registration.
 *
 * Fastmail normalizes a loopback `redirect_uri` by dropping the port (RFC 8252
 * §7.3 lets a native client's loopback port vary), so one registration keeps
 * working across the ephemeral ports {@link startOAuthCallbackServer} picks.
 */
async function registerClient(
  redirectUri: string,
  clientName: string
): Promise<RegistrationResponse> {
  const body = JSON.stringify({
    client_name: clientName,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    // Required. Fastmail records the scopes at registration time and rejects an
    // authorization request asking for anything outside them ("This MUST be a
    // subset of the scopes registered for the client"). Omitting this registers
    // the client with an empty scope, and every later authorize call comes back
    // to the callback with an error and no code.
    scope: OAUTH_SCOPES,
  });

  const result = await runCapturedAsync(
    ['-s', '-X', 'POST', '-H', 'Content-Type: application/json', '-d', body, REGISTRATION_ENDPOINT],
    30
  );

  if (result.returncode !== 0) {
    throw new LoginFailedError(`Failed to register OAuth client: ${result.stderr}`);
  }

  try {
    const response = JSON.parse(result.stdout) as RegistrationResponse;
    if (!response.client_id) {
      throw new LoginFailedError(
        `Client registration response missing client_id: ${result.stdout}`
      );
    }
    return response;
  } catch (error: unknown) {
    if (error instanceof LoginFailedError) {
      throw error;
    }
    throw new LoginFailedError(
      `Failed to parse client registration response: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Absolute expiry for an `expires_in`, or undefined when the server did not send
 * a usable one. `OAuthCredentials.accessTokenExpiresAt` is optional and
 * `isExpired()` answers "unknown" without it, so omitting it degrades to
 * refresh-on-failure. Computing it blindly would turn a missing value into
 * `new Date(NaN).toISOString()`, which throws RangeError and loses the tokens
 * that were just successfully obtained.
 */
function expiryFromExpiresIn(expiresIn: unknown): string | undefined {
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return undefined;
  }
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

/**
 * The JMAP session document names the authenticated account in `username`
 * (RFC 8620 §2), which for Fastmail is the account's e-mail address.
 */
function parseAccountFromSession(responseBody: string): string | null {
  const session = tryParseJson(responseBody) as { username?: string } | null;
  return session?.username ?? null;
}

class FastmailSession extends ServiceSession {
  onResponse(_response: Response): void {
    // Not used — login detection is via OAuth callback, not response inspection.
  }

  protected isLoginComplete(): boolean {
    // Not used — we override login() entirely.
    return false;
  }

  protected finalizeCredentials(
    _browser: Browser,
    _context: BrowserContext,
    _oldCredentials?: ApiCredentials
  ): Promise<ApiCredentials | null> {
    // Not used — we override login() entirely.
    return Promise.resolve(null);
  }

  override async login(
    encryptedStorage: import('../encryptedStorage.js').EncryptedStorage,
    launchOptions: import('../playwrightUtils.js').BrowserLaunchOptions = {},
    oldCredentials?: ApiCredentials
  ): Promise<LoginResult> {
    const { withTempBrowserContext } = await import('../playwrightUtils.js');

    return withTempBrowserContext(encryptedStorage, launchOptions, async ({ context }) => {
      const page = await context.newPage();

      const abortController = new AbortController();
      const closeHandler = () => {
        abortController.abort();
      };
      page.on('close', closeHandler);
      context.on('close', closeHandler);

      try {
        // 1. Start OAuth callback server
        const { port, codePromise } = await startOAuthCallbackServer(
          LOGIN_TIMEOUT_MS,
          abortController.signal
        );
        const redirectUri = `http://localhost:${port.toString()}/oauth2callback`;

        // 2. Register client or reuse existing client_id
        let clientId: string;
        if (oldCredentials instanceof OAuthCredentials && oldCredentials.clientId) {
          clientId = oldCredentials.clientId;
        } else {
          const registration = await registerClient(redirectUri, this.generateAppName());
          clientId = registration.client_id;
        }

        // 3. Generate PKCE verifier/challenge
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);

        // 4. Open browser to authorization URL
        const authUrl = new URL(AUTHORIZATION_ENDPOINT);
        authUrl.searchParams.set('client_id', clientId);
        authUrl.searchParams.set('redirect_uri', redirectUri);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('scope', OAUTH_SCOPES);
        authUrl.searchParams.set('resource', JMAP_RESOURCE);
        authUrl.searchParams.set('code_challenge', codeChallenge);
        authUrl.searchParams.set('code_challenge_method', 'S256');

        await page.goto(authUrl.toString());

        // 5. Wait for user to authorize and callback to receive code
        const code = await codePromise;

        // 6. Exchange code for tokens
        const tokens = await exchangeCodeForTokens(
          TOKEN_ENDPOINT,
          code,
          clientId,
          '', // public client, no secret
          redirectUri,
          codeVerifier,
          { resource: JMAP_RESOURCE }
        );

        const accessTokenExpiresAt = expiryFromExpiresIn(tokens.expires_in);

        await page.close();

        const credentials = new OAuthCredentials(
          clientId,
          '', // public client
          tokens.access_token,
          tokens.refresh_token,
          accessTokenExpiresAt
        );

        return {
          credentials,
          // The JMAP session document is the only thing that names the
          // account; Fastmail's token response carries no identity. A session
          // fetch that fails still leaves usable credentials, so fall back to
          // the placeholder rather than failing the whole login.
          account: (await this.service.getAccount(credentials)) ?? DEFAULT_ACCOUNT,
        };
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

export class Fastmail extends Service {
  readonly name = 'fastmail';
  readonly displayName = 'Fastmail';

  /**
   * Four host shapes, which is why these are patterns rather than plain
   * prefixes. Session discovery starts at `api.fastmail.com`, but the `apiUrl`
   * and `downloadUrl` it returns point at the shard the account is homed on
   * (`phl.api.fastmail.com`, `phl-www.fastmailusercontent.com`, …). Which
   * shard that is only becomes known after discovery, so the service has to
   * cover them all up front.
   *
   * The blob pattern is anchored on the `www` label rather than accepting any
   * subdomain: the session document only ever names `www.fastmailusercontent.com`
   * or `<shard>-www.…`, and this is the domain Fastmail uses to serve user
   * content, so matching it loosely would offer the access token to hosts the
   * credential has no business reaching.
   *
   * Deliberately NOT covering carddav.fastmail.com / caldav.fastmail.com. Those
   * advertise `WWW-Authenticate: Basic realm=..., Bearer`, so adding them looks
   * right, but Fastmail's OAuth access tokens are refused there (401 on every
   * path tried, including the principal and per-user collections) — the DAV
   * endpoints want an app password over Basic auth, which is a different
   * credential type than this service issues. Contacts and calendars are
   * reachable over JMAP on the hosts below instead.
   */
  readonly baseApiUrls = [
    /^https:\/\/([a-z0-9-]+\.)?api\.fastmail\.com\//,
    /^https:\/\/([a-z0-9-]+-)?www\.fastmailusercontent\.com\//,
  ] as const;

  readonly loginUrl = AUTHORIZATION_ENDPOINT;

  readonly info =
    'Fastmail mail, over JMAP (RFC 8620 core + RFC 8621 mail). ' +
    'https://www.fastmail.com/dev/ (developer docs) and ' +
    'https://jmap.io/spec.html (protocol spec). ' +
    'Start at https://api.fastmail.com/jmap/session — the session document names the ' +
    'apiUrl, downloadUrl and account ids to use for everything else; those point at the ' +
    'regional shard the account is homed on, which this service already covers. ' +
    `Browser login requests the scopes "${OAUTH_SCOPES}", which grant read AND write ` +
    'access to mail: Fastmail publishes no read-only OAuth scope (its registration endpoint ' +
    'rejects every :readonly variant). For a read-only credential, create an API token with ' +
    'read-only mail access — https://app.fastmail.com/settings/security, under ' +
    '"Connected apps & API tokens" / "Manage API tokens" — and supply it ' +
    'with `latchkey auth set` instead of logging in through the browser. ' +
    "Changing the requested scopes requires a NEW OAuth client: Fastmail fixes a client's " +
    'scopes at registration, and login reuses the client id stored with existing credentials. ' +
    'Run `latchkey auth clear fastmail --all` before logging in again, or the authorization ' +
    "is refused for asking outside the old client's scopes. " +
    'To see what the stored credential can actually reach, read the session document: each ' +
    'entry of its `accounts` map carries `isReadOnly` and an `accountCapabilities` map whose ' +
    'keys are the JMAP capabilities that credential can use (RFC 8620 §1.6.2). ' +
    'Note that https://api.fastmail.com/.well-known/jmap redirects to the session document ' +
    'on a different host, and curl drops the Authorization header across such a redirect — ' +
    'request /jmap/session directly instead of following the redirect.';

  readonly credentialCheckCurlArguments = [SESSION_ENDPOINT] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
  }

  /**
   * Fastmail accepts an OAuth client id prepared in advance via
   * `latchkey auth prepare`, stored as token-less OAuth credentials until
   * login. The login flow reuses this client id instead of registering a new
   * client dynamically.
   */
  override prepareFromJson(parsedJson: unknown): ApiCredentials {
    return buildPreparedCredentials(
      this.name,
      FastmailPrepareInputSchema,
      parsedJson,
      ({ clientId }) => new OAuthCredentials(clientId, '')
    );
  }

  override getAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    return fetchAccountFromEndpoint(
      apiCredentials,
      this.credentialCheckCurlArguments,
      parseAccountFromSession
    );
  }

  override getSession(appNamePrefix: string): FastmailSession {
    return new FastmailSession(this, appNamePrefix);
  }

  override async refreshCredentials(
    apiCredentials: ApiCredentials
  ): Promise<ApiCredentials | null> {
    if (!(apiCredentials instanceof OAuthCredentials)) {
      return null;
    }

    if (!apiCredentials.refreshToken) {
      return null;
    }

    const tokens = await refreshAccessToken(
      TOKEN_ENDPOINT,
      apiCredentials.refreshToken,
      apiCredentials.clientId,
      apiCredentials.clientSecret,
      { resource: JMAP_RESOURCE }
    );

    if (tokens === null) {
      return null;
    }

    const accessTokenExpiresAt = expiryFromExpiresIn(tokens.expires_in);

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

export const FASTMAIL = new Fastmail();
