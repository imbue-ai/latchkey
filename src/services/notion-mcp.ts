/**
 * Notion MCP service implementation.
 *
 * Uses OAuth 2.0 with PKCE via dynamic client registration at mcp.notion.com.
 * This is separate from the existing Notion service which uses internal integration tokens.
 */

import type { Browser, BrowserContext, Response } from 'playwright';
import { type ApiCredentials, OAuthCredentials } from '../apiCredentials/base.js';
import { runCaptured } from '../curl.js';
import { generateLatchkeyAppName } from '../playwrightUtils.js';
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
  LoginFailedError,
  LoginCancelledError,
  isBrowserClosedError,
} from './core/base.js';

const TOKEN_ENDPOINT = 'https://mcp.notion.com/token';
const REGISTRATION_ENDPOINT = 'https://mcp.notion.com/register';
const AUTHORIZATION_ENDPOINT = 'https://mcp.notion.com/authorize';
const LOGIN_TIMEOUT_MS = 120000;

interface RegistrationResponse {
  client_id: string;
  client_name?: string;
}

function registerClient(redirectUri: string): RegistrationResponse {
  const body = JSON.stringify({
    client_name: generateLatchkeyAppName('-mcp'),
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });

  const result = runCaptured(
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
  ): Promise<ApiCredentials> {
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
          const registration = registerClient(redirectUri);
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

        // 6. Exchange code for tokens
        const tokens = exchangeCodeForTokens(
          TOKEN_ENDPOINT,
          code,
          clientId,
          '', // public client, no secret
          redirectUri,
          codeVerifier
        );

        const accessTokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

        await page.close();

        return new OAuthCredentials(
          clientId,
          '', // public client
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

export class NotionMcp extends Service {
  readonly name = 'notion-mcp';
  readonly displayName = 'Notion MCP';
  readonly baseApiUrls = ['https://mcp.notion.com/'] as const;
  readonly loginUrl = AUTHORIZATION_ENDPOINT;
  readonly info = 'Notion MCP (Beta). OAuth 2.0 with PKCE via mcp.notion.com.';

  readonly credentialCheckCurlArguments = [
    '-X',
    'POST',
    '-H',
    'Content-Type: application/json',
    '-d',
    '{"jsonrpc":"2.0","method":"initialize","id":1}',
    'https://mcp.notion.com/mcp',
  ] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
  }

  override getSession(): NotionMcpSession {
    return new NotionMcpSession(this);
  }

  override refreshCredentials(apiCredentials: ApiCredentials): Promise<ApiCredentials | null> {
    if (!(apiCredentials instanceof OAuthCredentials)) {
      return Promise.resolve(null);
    }

    if (!apiCredentials.refreshToken) {
      return Promise.resolve(null);
    }

    const tokens = refreshAccessToken(
      TOKEN_ENDPOINT,
      apiCredentials.refreshToken,
      apiCredentials.clientId,
      apiCredentials.clientSecret
    );

    if (tokens === null) {
      return Promise.resolve(null);
    }

    const accessTokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

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

export const NOTION_MCP = new NotionMcp();
