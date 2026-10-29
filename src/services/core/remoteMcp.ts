/**
 * Shared implementation for services that are remote MCP servers.
 *
 * A remote MCP server (Streamable HTTP transport) is, from latchkey's point of
 * view, just a JSON-RPC-over-HTTP API protected by OAuth 2.1: the client
 * registers itself dynamically (RFC 7591), sends the user through the
 * authorization code flow with PKCE and then calls the endpoint with a bearer
 * token. Every such server is described by the same handful of URLs, so one
 * implementation serves them all; the first of them was Notion's, whose
 * connector this generalizes.
 */

import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Response } from 'playwright';
import { type ApiCredentials, OAuthCredentials } from '../../apiCredentials/base.js';
import {
  DEFAULT_ACCOUNT,
  fetchAccountFromEndpoint,
  tryParseJson,
} from '../../apiCredentials/account.js';
import { runCapturedAsync } from '../../curl.js';
import type { EncryptedStorage } from '../../encryptedStorage.js';
import {
  buildLoopbackRedirectUri,
  exchangeCodeForTokens,
  generateCodeChallenge,
  generateCodeVerifier,
  readRedirectUriOverride,
  refreshAccessToken,
  startOAuthCallbackServer,
  type OAuthTokenResponse,
} from '../../oauthUtils.js';
import type { BrowserLaunchOptions } from '../../playwrightUtils.js';
import {
  Service,
  ServiceSession,
  type LoginResult,
  LoginFailedError,
  LoginCancelledError,
  DynamicClientPrepareInputSchema,
  buildDynamicClientPreparation,
  buildPreparedCredentials,
  isBrowserClosedError,
} from './base.js';

const LOGIN_TIMEOUT_MS = 120000;

/**
 * The OAuth 2.1 authorization server in front of an MCP server, as published
 * in its `/.well-known/oauth-authorization-server` metadata (RFC 8414). The
 * MCP server names that authorization server in its own protected resource
 * metadata (RFC 9728, `/.well-known/oauth-protected-resource`).
 */
export interface RemoteMcpOAuthEndpoints {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  /** Dynamic client registration (RFC 7591). */
  readonly registrationEndpoint: string;
}

export interface RemoteMcpServiceDefinition {
  readonly name: string;
  readonly displayName: string;
  /** The Streamable HTTP endpoint JSON-RPC messages are POSTed to. */
  readonly mcpEndpoint: string;
  readonly oauth: RemoteMcpOAuthEndpoints;
  /** Developer notes, see {@link Service.info}. */
  readonly info: string;
  /**
   * The scopes to ask for. Left empty for the many servers that have none and
   * grant whatever the user consents to; set for those whose metadata lists
   * `scopes_supported` or whose 401 challenge names a `scope`.
   */
  readonly scopes?: readonly string[];
  /**
   * URL prefixes (or patterns) of the API besides the MCP endpoint's own
   * origin, e.g. the regional hosts of a server that is deployed per region.
   * Login always goes through `mcpEndpoint`; a token obtained elsewhere (or
   * stored by hand) is injected into calls to any of these.
   */
  readonly additionalBaseApiUrls?: readonly (string | RegExp)[];
  /**
   * Whether the token endpoint hands out a refresh token alongside the access
   * token. Left at the default for the usual case; false for a server that is
   * known to issue access tokens only, whose login would otherwise be
   * refused for want of a refresh token.
   */
  readonly issuesRefreshTokens?: boolean;
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

/**
 * The RFC 7591 registration request for a public client (no secret, PKCE
 * instead) that receives authorization codes at `redirectUri`.
 */
export function buildClientRegistrationBody(
  redirectUri: string,
  clientName: string,
  scopes: readonly string[]
): Record<string, unknown> {
  return {
    client_name: clientName,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...(scopes.length > 0 ? { scope: scopes.join(' ') } : {}),
  };
}

export interface AuthorizationRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string;
  readonly scopes: readonly string[];
  /** The MCP endpoint the token is for (RFC 8707 `resource`). */
  readonly resource: string;
}

/**
 * The authorization URL to send the user to. The `resource` parameter names
 * the MCP server the token is meant for, as the MCP authorization spec
 * requires of clients; servers that do not pin tokens to an audience ignore
 * it, as RFC 6749 §3.1 tells them to.
 */
export function buildAuthorizationUrl(
  authorizationEndpoint: string,
  request: AuthorizationRequest
): string {
  const url = new URL(authorizationEndpoint);
  url.searchParams.set('client_id', request.clientId);
  url.searchParams.set('redirect_uri', request.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('code_challenge', request.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', request.state);
  url.searchParams.set('resource', request.resource);
  if (request.scopes.length > 0) {
    url.searchParams.set('scope', request.scopes.join(' '));
  }
  return url.toString();
}

/**
 * Curl arguments for a single JSON-RPC request to an MCP endpoint. MCP
 * Streamable HTTP requires clients to advertise both JSON and SSE acceptance
 * (spec 2025-06-18 §Sending Messages, item 2); servers answer HTTP 406
 * otherwise.
 */
export function buildMcpRequestCurlArguments(
  mcpEndpoint: string,
  message: Record<string, unknown>
): readonly string[] {
  return [
    '-X',
    'POST',
    '-H',
    'Content-Type: application/json',
    '-H',
    'Accept: application/json, text/event-stream',
    '-d',
    JSON.stringify(message),
    mcpEndpoint,
  ];
}

/**
 * The `initialize` request, which every MCP server answers and which needs no
 * session, so it doubles as the credential check: the server rejects it with
 * HTTP 401 when the bearer token is missing or stale.
 */
export function buildMcpInitializeCurlArguments(mcpEndpoint: string): readonly string[] {
  return buildMcpRequestCurlArguments(mcpEndpoint, {
    jsonrpc: '2.0',
    method: 'initialize',
    id: 1,
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'latchkey', version: '1' },
    },
  });
}

/**
 * Parse an MCP Streamable HTTP response body: either a plain JSON-RPC message
 * or an SSE stream whose `data:` lines carry JSON-RPC messages (the last
 * parseable one wins, which is the response to our request).
 */
export function parseMcpResponseBody(body: string): unknown {
  const trimmed = body.trim();
  if (trimmed.startsWith('data:') || trimmed.startsWith('event:') || trimmed.startsWith(':')) {
    let lastParsedMessage: unknown = null;
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('data:')) {
        const parsed = tryParseJson(line.slice('data:'.length).trim());
        if (parsed !== null) {
          lastParsedMessage = parsed;
        }
      }
    }
    return lastParsedMessage;
  }
  return tryParseJson(trimmed);
}

/**
 * The text content parts of a `tools/call` result, in order. Empty when the
 * body is not a successful tool result (an error, an SSE stream without one,
 * garbage).
 */
export function extractMcpToolResultTexts(responseBody: string): readonly string[] {
  const message = parseMcpResponseBody(responseBody) as {
    result?: { content?: readonly { type?: string; text?: string }[] };
  } | null;
  const content = message?.result?.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return (content as readonly { type?: string; text?: string }[]).flatMap((part) =>
    part.type === 'text' && typeof part.text === 'string' ? [part.text] : []
  );
}

/**
 * Determine the account behind the credentials by calling an identity-revealing
 * MCP tool: a single stateless `tools/call` (no `initialize` handshake, which
 * the servers this is used with do not insist on) whose text results are
 * handed to `parseAccount` one by one until one yields an account. The shared
 * implementation behind the remote MCP services' `getAccount()`.
 */
export function fetchAccountFromMcpTool(
  apiCredentials: ApiCredentials,
  mcpEndpoint: string,
  toolName: string,
  toolArguments: Record<string, unknown>,
  parseAccount: (toolResultText: string) => string | null
): Promise<string | null> {
  return fetchAccountFromEndpoint(
    apiCredentials,
    buildMcpRequestCurlArguments(mcpEndpoint, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: toolArguments },
    }),
    (responseBody) => {
      for (const text of extractMcpToolResultTexts(responseBody)) {
        const account = parseAccount(text);
        if (account !== null) {
          return account;
        }
      }
      return null;
    }
  );
}

interface RegistrationResponse {
  client_id: string;
  /**
   * Some servers hand a secret even to a client that registered as public
   * (`token_endpoint_auth_method: none`) and then expect it at the token
   * endpoint. It is kept and sent back when present; the usual public client
   * has none.
   */
  client_secret: string;
}

async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  clientName: string,
  scopes: readonly string[]
): Promise<RegistrationResponse> {
  const result = await runCapturedAsync(
    [
      '-s',
      '-X',
      'POST',
      '-H',
      'Content-Type: application/json',
      '-d',
      JSON.stringify(buildClientRegistrationBody(redirectUri, clientName, scopes)),
      registrationEndpoint,
    ],
    30
  );

  if (result.returncode !== 0) {
    throw new LoginFailedError(`Failed to register OAuth client: ${result.stderr}`);
  }

  const response = tryParseJson(result.stdout) as Partial<RegistrationResponse> | null;
  if (response === null || typeof response !== 'object') {
    throw new LoginFailedError(`Failed to parse client registration response: ${result.stdout}`);
  }
  if (!response.client_id) {
    throw new LoginFailedError(`Client registration response missing client_id: ${result.stdout}`);
  }
  return {
    client_id: response.client_id,
    client_secret: typeof response.client_secret === 'string' ? response.client_secret : '',
  };
}

/**
 * Browser login session for a remote MCP server: dynamic client registration,
 * then the OAuth authorization code flow with PKCE in a Playwright browser.
 * `login()` is overridden wholesale, as the base template's static loginUrl +
 * response-watching model does not fit a per-session authorize URL with a
 * loopback callback.
 */
export class RemoteMcpSession extends ServiceSession {
  override readonly service: RemoteMcpService;

  constructor(service: RemoteMcpService, appNamePrefix: string) {
    super(service, appNamePrefix);
    this.service = service;
  }

  onResponse(_response: Response): void {
    // Not used — login detection is via the OAuth callback, not response inspection.
  }

  protected isLoginComplete(): boolean {
    // Not used — login() is overridden entirely.
    return false;
  }

  protected finalizeCredentials(
    _browser: Browser,
    _context: BrowserContext,
    _oldCredentials?: ApiCredentials
  ): Promise<ApiCredentials | null> {
    // Not used — login() is overridden entirely.
    return Promise.resolve(null);
  }

  override async login(
    encryptedStorage: EncryptedStorage,
    launchOptions: BrowserLaunchOptions = {},
    oldCredentials?: ApiCredentials
  ): Promise<LoginResult> {
    const { withTempBrowserContext } = await import('../../playwrightUtils.js');
    const { mcpEndpoint, oauth, scopes, issuesRefreshTokens } = this.service.definition;

    return withTempBrowserContext(encryptedStorage, launchOptions, async ({ context }) => {
      const page = await context.newPage();

      const abortController = new AbortController();
      const closeHandler = () => {
        abortController.abort();
      };
      page.on('close', closeHandler);
      context.on('close', closeHandler);

      try {
        const { port, codePromise } = await startOAuthCallbackServer(
          LOGIN_TIMEOUT_MS,
          abortController.signal
        );
        // A prepared redirect URI wins over the loopback one; the page it
        // serves forwards the authorization result to the loopback callback,
        // whose port it reads out of the state below.
        const redirectUriOverride = readRedirectUriOverride(oldCredentials);
        const redirectUri = redirectUriOverride ?? buildLoopbackRedirectUri(port);
        const state = buildAuthorizationState(port);

        // Reuse a prepared or previously registered client; register otherwise.
        const client =
          oldCredentials instanceof OAuthCredentials && oldCredentials.clientId
            ? { client_id: oldCredentials.clientId, client_secret: oldCredentials.clientSecret }
            : await registerClient(
                oauth.registrationEndpoint,
                redirectUri,
                this.generateAppName('-mcp'),
                scopes ?? []
              );
        const clientId = client.client_id;

        const codeVerifier = generateCodeVerifier();
        const authorizationUrl = buildAuthorizationUrl(oauth.authorizationEndpoint, {
          clientId,
          redirectUri,
          codeChallenge: generateCodeChallenge(codeVerifier),
          state,
          scopes: scopes ?? [],
          resource: mcpEndpoint,
        });
        await page.goto(authorizationUrl, { waitUntil: 'domcontentloaded' });

        const code = await codePromise;

        const tokens = await exchangeCodeForTokens(
          oauth.tokenEndpoint,
          code,
          clientId,
          client.client_secret,
          redirectUri,
          codeVerifier,
          { resource: mcpEndpoint },
          { refreshTokenRequired: issuesRefreshTokens ?? true }
        );

        await page.close();

        const credentials = new OAuthCredentials(
          clientId,
          client.client_secret,
          tokens.access_token,
          tokens.refresh_token,
          accessTokenExpiresAtFrom(tokens),
          undefined,
          // Carried over so that a re-login reuses the prepared redirect URI
          // alongside the prepared client id.
          redirectUriOverride
        );

        return {
          credentials,
          account:
            (await this.service.getAccount?.(credentials)) ??
            this.service.accountFromTokenResponse(tokens),
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

/**
 * When the access token expires, as an ISO timestamp; unknown when the server
 * did not say (`expires_in` is optional in RFC 6749 §5.1).
 */
function accessTokenExpiresAtFrom(tokens: OAuthTokenResponse): string | undefined {
  // The typed field is required, but the response is parsed from arbitrary
  // JSON and the field is in fact optional in the protocol.
  const expiresIn = (tokens as { expires_in?: unknown }).expires_in;
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
    return undefined;
  }
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

/**
 * A service that is a remote MCP server behind OAuth 2.1 with dynamic client
 * registration. Instantiated directly from a definition for the common case;
 * subclassed by servers that can tell which account a token belongs to.
 */
export class RemoteMcpService extends Service {
  readonly definition: RemoteMcpServiceDefinition;
  readonly name: string;
  readonly displayName: string;
  readonly baseApiUrls: readonly (string | RegExp)[];
  readonly loginUrl: string;
  readonly info: string;
  readonly credentialCheckCurlArguments: readonly string[];

  constructor(definition: RemoteMcpServiceDefinition) {
    super();
    this.definition = definition;
    this.name = definition.name;
    this.displayName = definition.displayName;
    this.baseApiUrls = [
      `${new URL(definition.mcpEndpoint).origin}/`,
      ...(definition.additionalBaseApiUrls ?? []),
    ];
    this.loginUrl = definition.oauth.authorizationEndpoint;
    this.info = definition.info;
    this.credentialCheckCurlArguments = buildMcpInitializeCurlArguments(definition.mcpEndpoint);
  }

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
  }

  /**
   * Accepts an OAuth client id to reuse instead of registering a new client,
   * and/or the redirect URI to use — prepared in advance via `latchkey auth
   * prepare` and stored as token-less OAuth credentials until login (see
   * `DynamicClientPrepareInputSchema`).
   */
  override prepareFromJson(parsedJson: unknown): ApiCredentials {
    return buildPreparedCredentials(
      this.name,
      DynamicClientPrepareInputSchema,
      parsedJson,
      buildDynamicClientPreparation
    );
  }

  /**
   * The account to store a fresh login under when `getAccount` has nothing to
   * say, derived from whatever identity the token response happens to carry.
   * Most servers carry none, hence the default account.
   */
  accountFromTokenResponse(_tokens: OAuthTokenResponse): string {
    return DEFAULT_ACCOUNT;
  }

  override getSession(appNamePrefix: string): RemoteMcpSession {
    return new RemoteMcpSession(this, appNamePrefix);
  }

  override async refreshCredentials(
    apiCredentials: ApiCredentials
  ): Promise<ApiCredentials | null> {
    if (!(apiCredentials instanceof OAuthCredentials) || !apiCredentials.refreshToken) {
      return null;
    }

    const tokens = await refreshAccessToken(
      this.definition.oauth.tokenEndpoint,
      apiCredentials.refreshToken,
      apiCredentials.clientId,
      apiCredentials.clientSecret,
      { resource: this.definition.mcpEndpoint }
    );
    if (tokens === null) {
      return null;
    }

    return new OAuthCredentials(
      apiCredentials.clientId,
      apiCredentials.clientSecret,
      tokens.access_token,
      tokens.refresh_token ?? apiCredentials.refreshToken,
      accessTokenExpiresAtFrom(tokens),
      apiCredentials.refreshTokenExpiresAt,
      apiCredentials.redirectUri
    );
  }
}
