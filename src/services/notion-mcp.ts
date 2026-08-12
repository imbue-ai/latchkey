/**
 * Notion MCP service implementation.
 *
 * Uses OAuth 2.0 with PKCE via dynamic client registration at mcp.notion.com.
 * This is separate from the existing Notion service which uses internal integration tokens.
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
 * JSON accepted by `latchkey auth prepare notion-mcp`: the OAuth client id to
 * reuse instead of registering a new client dynamically at mcp.notion.com.
 * Notion MCP is a public client, so no secret is needed. `.strict()` rejects
 * unknown keys so typos are reported instead of silently ignored.
 */
export const NotionMcpPrepareInputSchema = z
  .object({
    clientId: z.string().min(1),
  })
  .strict();

export type NotionMcpPrepareInput = z.infer<typeof NotionMcpPrepareInputSchema>;

const MCP_ENDPOINT = 'https://mcp.notion.com/mcp';
const TOKEN_ENDPOINT = 'https://mcp.notion.com/token';
const REGISTRATION_ENDPOINT = 'https://mcp.notion.com/register';
const AUTHORIZATION_ENDPOINT = 'https://mcp.notion.com/authorize';
const LOGIN_TIMEOUT_MS = 120000;

interface RegistrationResponse {
  client_id: string;
  client_name?: string;
}

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
 * Fallback account derivation from the token-exchange response, used when the
 * MCP `get-users` lookup fails. Notion's MCP token endpoint reports `user_id`,
 * `workspace_id` and `email_domain` (but not the full e-mail or the workspace
 * name), so the best it can offer is the opaque user id combined with the
 * e-mail domain.
 */
function parseAccountFromTokenResponse(tokens: {
  user_id?: string;
  workspace_id?: string;
  email_domain?: string;
}): string {
  const workspacePart = tokens.email_domain ?? tokens.workspace_id;
  if (tokens.user_id !== undefined && workspacePart !== undefined) {
    return `${tokens.user_id}@${workspacePart}`;
  }
  return tokens.user_id ?? tokens.workspace_id ?? DEFAULT_ACCOUNT;
}

/**
 * A single stateless `tools/call` asking the `notion-get-users` tool for the
 * current user. Notion's MCP server does not require the initialize handshake
 * or a session id for this, so one POST is enough.
 */
const GET_SELF_CURL_ARGUMENTS = [
  '-X',
  'POST',
  '-H',
  'Content-Type: application/json',
  '-H',
  'Accept: application/json, text/event-stream',
  '-d',
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'notion-get-users', arguments: { user_id: 'self' } },
  }),
  MCP_ENDPOINT,
] as const;

/**
 * Parse an MCP Streamable HTTP response body: either a plain JSON-RPC message
 * or an SSE stream whose `data:` lines carry JSON-RPC messages (the last
 * parseable one wins, which is the response to our request).
 */
function parseMcpResponseBody(body: string): unknown {
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
 * Extract the current user from a `notion-get-users` tool response. The tool
 * result rides as JSON text inside the MCP content parts, e.g.
 * `{"results":[{"type":"person","id":"...","name":"Hynek Urban","email":
 * "hynek@imbue.com"}],"has_more":false}`. Prefers the e-mail; falls back to
 * the name (bots have no e-mail).
 */
function parseAccountFromGetUsersResponse(responseBody: string): string | null {
  const message = parseMcpResponseBody(responseBody) as {
    result?: { content?: readonly { type?: string; text?: string }[] };
  } | null;
  const content = message?.result?.content;
  if (!Array.isArray(content)) {
    return null;
  }
  for (const part of content as readonly { type?: string; text?: string }[]) {
    if (part.type !== 'text' || typeof part.text !== 'string') {
      continue;
    }
    const toolResult = tryParseJson(part.text) as {
      results?: readonly { email?: string; name?: string }[];
    } | null;
    const self = toolResult?.results?.[0];
    if (self !== undefined) {
      return self.email ?? self.name ?? null;
    }
  }
  return null;
}

class NotionMcpSession extends ServiceSession {
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
          const registration = await registerClient(redirectUri, this.generateAppName('-mcp'));
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
        authUrl.searchParams.set('code_challenge', codeChallenge);
        authUrl.searchParams.set('code_challenge_method', 'S256');

        await page.goto(authUrl.toString());

        // 5. Wait for user to authorize and callback to receive code
        const code = await codePromise;

        // 6. Exchange code for tokens. Besides the tokens, Notion's MCP token
        // endpoint reports who authorized: user_id, workspace_id and
        // email_domain ride along in the same response.
        const tokens = (await exchangeCodeForTokens(
          TOKEN_ENDPOINT,
          code,
          clientId,
          '', // public client, no secret
          redirectUri,
          codeVerifier
        )) as Awaited<ReturnType<typeof exchangeCodeForTokens>> & {
          user_id?: string;
          workspace_id?: string;
          email_domain?: string;
        };

        const accessTokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

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
          // Prefer the full e-mail resolved via the MCP get-users tool; fall
          // back to the coarser identity riding along in the token response.
          account:
            (await this.service.getAccount(credentials)) ?? parseAccountFromTokenResponse(tokens),
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

export class NotionMcp extends Service {
  readonly name = 'notion-mcp';
  readonly displayName = 'Notion MCP';
  readonly baseApiUrls = ['https://mcp.notion.com/'] as const;
  readonly loginUrl = AUTHORIZATION_ENDPOINT;
  readonly info =
    'Use Notion\'s MCP endpoints as a "normal" JSON API. ' +
    'https://developers.notion.com/guides/mcp/build-mcp-client (integration guide: server URL, transport, OAuth, worked client code). ' +
    'https://developers.notion.com/guides/mcp/mcp-supported-tools (tool catalog: names, descriptions, example prompts). ' +
    'https://spec.modelcontextprotocol.io (MCP protocol spec for JSON-RPC framing). ' +
    'Tool input schemas are not published as static docs — use authed MCP to call `tools/list` at runtime to discover them.';

  readonly credentialCheckCurlArguments = [
    '-X',
    'POST',
    '-H',
    'Content-Type: application/json',
    // MCP Streamable HTTP requires clients to advertise both JSON and SSE
    // acceptance (spec 2025-06-18 §Sending Messages, item 2); mcp.notion.com
    // returns HTTP 406 otherwise, which would mark valid tokens as Invalid.
    '-H',
    'Accept: application/json, text/event-stream',
    '-d',
    '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"latchkey","version":"1"}}}',
    'https://mcp.notion.com/mcp',
  ] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
  }

  /**
   * Notion MCP accepts an OAuth client id prepared in advance via
   * `latchkey auth prepare`, stored as token-less OAuth credentials until login.
   * The login flow reuses this client id instead of registering a new client.
   */
  override prepareFromJson(parsedJson: unknown): ApiCredentials {
    return buildPreparedCredentials(
      this.name,
      NotionMcpPrepareInputSchema,
      parsedJson,
      ({ clientId }) => new OAuthCredentials(clientId, '')
    );
  }

  // MCP-audienced tokens cannot call the classic REST API, but the MCP
  // endpoint itself can reveal the identity: the `get-users` tool returns the
  // current user's name and e-mail when asked for `self`.
  getAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    return fetchAccountFromEndpoint(
      apiCredentials,
      GET_SELF_CURL_ARGUMENTS,
      parseAccountFromGetUsersResponse
    );
  }

  override getSession(appNamePrefix: string): NotionMcpSession {
    return new NotionMcpSession(this, appNamePrefix);
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
      apiCredentials.clientSecret
    );

    if (tokens === null) {
      return null;
    }

    const accessTokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

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

export const NOTION_MCP = new NotionMcp();
