/**
 * WordPress.com service implementation with OAuth flow.
 */

import type { Browser, BrowserContext, Page, Response } from 'playwright';
import { evaluateMathExpression, MathEvalError } from '../mathEval.js';
import { ApiCredentialStatus, ApiCredentials, OAuthCredentials } from '../apiCredentials.js';
import {
  generateLatchkeyAppName,
  showSpinnerPage,
  withTempBrowserContext,
  type BrowserLaunchOptions,
} from '../playwrightUtils.js';
import { runCaptured } from '../curl.js';
import {
  exchangeCodeForTokens,
  refreshAccessToken,
  startOAuthCallbackServer,
} from '../oauthUtils.js';
import {
  Service,
  BrowserFollowupServiceSession,
  LoginFailedError,
  LoginCancelledError,
  isBrowserClosedError,
} from './base.js';
import type { EncryptedStorage } from '../encryptedStorage.js';

const DEFAULT_TIMEOUT_MS = 8000;
const LOGIN_TIMEOUT_MS = 120000;
const WORDPRESS_TOKEN_ENDPOINT = 'https://public-api.wordpress.com/oauth2/token';
const OAUTH_PORTS_START = 8000;
const OAUTH_PORTS_COUNT = 10;

function checkWordPressLoginResponse(
  response: Response,
  loginDetector: { isLoggedIn: boolean }
): void {
  if (loginDetector.isLoggedIn) {
    return;
  }

  const request = response.request();
  // Detect successful login by checking if we can access the apps page
  // When not logged in, the server returns 302 redirect to login page
  // When logged in, the server returns 200
  if (request.url() === 'https://developer.wordpress.com/apps/new/' && response.status() === 200) {
    loginDetector.isLoggedIn = true;
  }
}

async function waitForWordPressLogin(page: Page): Promise<void> {
  const loginDetector = { isLoggedIn: false };

  const responseHandler = (response: Response) => {
    checkWordPressLoginResponse(response, loginDetector);
  };

  page.on('response', responseHandler);

  while (!loginDetector.isLoggedIn) {
    await page.waitForTimeout(100);
  }

  page.off('response', responseHandler);
}

/**
 * Solve the arithmetic captcha by extracting and evaluating the expression.
 * The captcha question is in the format "What is X + Y?" or "What is X - Y?", etc.
 */
function solveMathCaptcha(question: string): string {
  // Extract the mathematical expression from the question
  // Example: "What is 7 + 1?" -> "7 + 1"
  const regex = /What is (.+)\?/i;
  const match = regex.exec(question);
  if (!match?.[1]) {
    throw new LoginFailedError(`Unable to parse captcha question: ${question}`);
  }

  const expression = match[1].trim();

  try {
    return evaluateMathExpression(expression);
  } catch (error: unknown) {
    if (error instanceof MathEvalError) {
      throw new LoginFailedError(`Failed to solve captcha: ${error.message}`);
    }
    throw new LoginFailedError(
      `Failed to solve captcha: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function createOAuthApp(page: Page): Promise<{ clientId: string; clientSecret: string }> {
  // We're already on the /apps/new/ page from the initial navigation
  // Fill in the app name
  const nameInput = page.locator('#title');
  await nameInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await nameInput.fill(generateLatchkeyAppName());

  // Fill in the description
  const descriptionInput = page.locator('#description');
  await descriptionInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await descriptionInput.fill('Latchkey API key');

  // Fill in the website URL
  const urlInput = page.locator('#url');
  await urlInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await urlInput.fill('https://example.com');

  // Fill in the redirect URLs (10 localhost ports)
  const redirectUris = Array.from(
    { length: OAUTH_PORTS_COUNT },
    (_, i) => `http://localhost:${(OAUTH_PORTS_START + i).toString()}`
  ).join('\n');

  const redirectUriInput = page.locator('#redirect_uri');
  await redirectUriInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await redirectUriInput.fill(redirectUris);

  // Solve the math captcha
  const mathInput = page.locator('#math');
  await mathInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });

  const mathQuestion = await page.locator('label[for="math"]').textContent();
  if (!mathQuestion) {
    throw new LoginFailedError('Unable to find math captcha question');
  }

  const mathAnswer = solveMathCaptcha(mathQuestion);
  await mathInput.fill(mathAnswer);

  // Submit the form
  const submitButton = page.locator('input[type="submit"]');
  await submitButton.click();

  // Wait for redirect to the app page (may be /apps/{ID}/settings/?msg=created or /apps/{ID}/)
  await page.waitForURL(/https:\/\/developer\.wordpress\.com\/apps\/\d+/, {
    timeout: DEFAULT_TIMEOUT_MS,
  });

  // Extract the app ID from the current URL and navigate to the main app page
  // The URL might be /apps/{ID}/settings/?msg=created, so we need to extract just the ID
  const currentUrl = new URL(page.url());
  const pathMatch = /^\/apps\/(\d+)/.exec(currentUrl.pathname);
  if (!pathMatch?.[1]) {
    throw new LoginFailedError(`Unable to extract app ID from URL: ${page.url()}`);
  }

  const appId = pathMatch[1];
  const appUrl = `https://developer.wordpress.com/apps/${appId}/`;

  // Navigate to the main app page where credentials are displayed
  await page.goto(appUrl, { timeout: DEFAULT_TIMEOUT_MS });

  // Extract the client ID and client secret from the OAuth information table
  // Client ID is in plain text, Client Secret is in a <pre> tag
  const table = page.locator('table.api-doc');
  await table.waitFor({ timeout: DEFAULT_TIMEOUT_MS });

  // Find the Client ID row by looking for the header, then get the adjacent cell
  const clientIdRow = table.locator('tr').filter({ hasText: 'Client ID' });
  const clientIdCell = clientIdRow.locator('td.api-index-item-body');
  const clientId = (await clientIdCell.textContent())?.trim() ?? '';

  // Find the Client Secret row by looking for the header, then get the <pre> tag
  const clientSecretRow = table.locator('tr').filter({ hasText: 'Client Secret' });
  const clientSecretPre = clientSecretRow.locator('pre');
  const clientSecret = (await clientSecretPre.textContent())?.trim() ?? '';

  if (!clientId || !clientSecret) {
    throw new LoginFailedError(
      `Failed to extract OAuth credentials (Client ID: ${clientId ? 'found' : 'missing'}, Client Secret: ${clientSecret ? 'found' : 'missing'})`
    );
  }

  return { clientId, clientSecret };
}

class WordPressComServiceSession extends BrowserFollowupServiceSession {
  private readonly loginDetector = { isLoggedIn: false };

  onResponse(response: Response): void {
    checkWordPressLoginResponse(response, this.loginDetector);
  }

  protected isLoginComplete(): boolean {
    return this.loginDetector.isLoggedIn;
  }

  /**
   * Override to skip the spinner page since the OAuth flow requires user interaction
   * (granting consent on WordPress.com's authorization page).
   */
  protected override finalizeCredentials(
    _browser: Browser,
    context: BrowserContext,
    oldCredentials?: ApiCredentials
  ): Promise<ApiCredentials | null> {
    return this.performBrowserFollowup(context, oldCredentials);
  }

  protected async performBrowserFollowup(
    context: BrowserContext,
    oldCredentials?: ApiCredentials
  ): Promise<ApiCredentials | null> {
    const page = context.pages()[0];
    if (!page) {
      throw new LoginFailedError('No page available in browser context.');
    }

    // Require existing credentials with client ID and secret
    if (!(oldCredentials instanceof OAuthCredentials)) {
      throw new LoginFailedError(
        'WordPress.com login requires existing OAuth client credentials. Run prepare first.'
      );
    }

    const clientId = oldCredentials.clientId;
    const clientSecret = oldCredentials.clientSecret;

    // Perform OAuth flow with localhost server
    const { accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt } =
      await this.performOAuthFlow(context, page, clientId, clientSecret);

    await page.close();

    return new OAuthCredentials(
      clientId,
      clientSecret,
      accessToken,
      refreshToken,
      accessTokenExpiresAt,
      refreshTokenExpiresAt
    );
  }

  private async performOAuthFlow(
    context: BrowserContext,
    page: Page,
    clientId: string,
    clientSecret: string
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt?: string;
    refreshTokenExpiresAt?: string;
  }> {
    // Use an AbortController to signal the OAuth callback server to shut down
    // when the browser is closed. Listen to both page and context close events
    // to handle all cases where the user might close the browser.
    const abortController = new AbortController();
    const closeHandler = () => {
      abortController.abort();
    };
    page.on('close', closeHandler);
    context.on('close', closeHandler);

    try {
      // Start the callback server on one of the configured ports
      // Try each port in the range until one succeeds
      let server: { port: number; codePromise: Promise<string> } | null = null;
      let lastError: Error | null = null;

      for (let i = 0; i < OAUTH_PORTS_COUNT; i++) {
        const targetPort = OAUTH_PORTS_START + i;
        try {
          // Try to start the server on this specific port
          server = await startOAuthCallbackServer(
            LOGIN_TIMEOUT_MS,
            abortController.signal,
            '/oauth2callback',
            targetPort
          );
          break; // Successfully started on this port
        } catch (error: unknown) {
          lastError = error instanceof Error ? error : new Error(String(error));
          // Continue to next port
        }
      }

      if (!server) {
        throw new LoginFailedError(
          `Failed to start OAuth callback server on ports ${OAUTH_PORTS_START.toString()}-${(OAUTH_PORTS_START + OAUTH_PORTS_COUNT - 1).toString()}: ${lastError?.message ?? 'Unknown error'}`
        );
      }

      const redirectUri = `http://localhost:${server.port.toString()}/oauth2callback`;

      const authUrl = new URL('https://public-api.wordpress.com/oauth2/authorize');
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');

      await page.goto(authUrl.toString());

      // Click the approve button to authorize the app
      const approveButton = page.locator('#approve');
      await approveButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
      await approveButton.click();

      // Wait for the authorization code from the callback
      const code = await server.codePromise;
      const tokens = exchangeCodeForTokens(
        WORDPRESS_TOKEN_ENDPOINT,
        code,
        clientId,
        clientSecret,
        redirectUri
      );

      // WordPress.com doesn't return refresh tokens or expiration times
      // Access tokens don't expire, so we don't set accessTokenExpiresAt
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? '',
        accessTokenExpiresAt: tokens.expires_in
          ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
          : undefined,
        refreshTokenExpiresAt: undefined,
      };
    } catch (error: unknown) {
      if (error instanceof Error && isBrowserClosedError(error)) {
        throw new LoginCancelledError();
      }
      throw error;
    } finally {
      // Remove the close handlers to prevent them from firing when context
      // is closed normally during cleanup
      page.off('close', closeHandler);
      context.off('close', closeHandler);
    }
  }
}

export class WordPressCom implements Service {
  readonly name = 'wordpressCom';
  readonly displayName = 'WordPress.com';
  readonly baseApiUrls = ['https://public-api.wordpress.com/'] as const;
  readonly loginUrl = 'https://developer.wordpress.com/apps/new/';
  readonly info =
    'Supports WordPress.com REST API for managing WordPress sites and content. ' +
    'If needed, run "latchkey prepare wordpressCom" to create an OAuth app first.';

  readonly credentialCheckCurlArguments = [
    'https://public-api.wordpress.com/rest/v1.1/me',
  ] as const;

  getSession(): WordPressComServiceSession {
    return new WordPressComServiceSession(this);
  }

  checkApiCredentials(apiCredentials: ApiCredentials): ApiCredentialStatus {
    if (!(apiCredentials instanceof OAuthCredentials)) {
      return ApiCredentialStatus.Invalid;
    }

    // Credentials from prepare() don't have tokens yet
    if (apiCredentials.accessToken === undefined) {
      return ApiCredentialStatus.Missing;
    }

    const result = runCaptured(
      [
        '-s',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        ...apiCredentials.asCurlArguments(),
        ...this.credentialCheckCurlArguments,
      ],
      10
    );

    if (result.stdout === '200') {
      return ApiCredentialStatus.Valid;
    }
    return ApiCredentialStatus.Invalid;
  }

  async prepare(
    encryptedStorage: EncryptedStorage,
    launchOptions?: BrowserLaunchOptions
  ): Promise<ApiCredentials> {
    return withTempBrowserContext(encryptedStorage, launchOptions ?? {}, async ({ context }) => {
      const page = await context.newPage();
      await page.goto(this.loginUrl);
      // TODO: If the user needs to log in with a link (https://wordpress.com/log-in/link),
      // we should inject a banner asking the user to paste the URL into this browser.
      await waitForWordPressLogin(page);

      await showSpinnerPage(
        context,
        `Finalizing ${this.displayName} login...\nCreating OAuth application...`
      );
      const { clientId, clientSecret } = await createOAuthApp(page);
      await page.close();
      return new OAuthCredentials(clientId, clientSecret);
    });
  }

  refreshCredentials(apiCredentials: ApiCredentials): Promise<ApiCredentials | null> {
    if (!(apiCredentials instanceof OAuthCredentials)) {
      return Promise.resolve(null);
    }

    if (!apiCredentials.refreshToken) {
      return Promise.resolve(null);
    }

    const tokens = refreshAccessToken(
      WORDPRESS_TOKEN_ENDPOINT,
      apiCredentials.refreshToken,
      apiCredentials.clientId,
      apiCredentials.clientSecret
    );

    if (tokens === null) {
      return Promise.resolve(null);
    }

    // WordPress.com tokens don't have expiration times
    const accessTokenExpiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : undefined;

    // Return new credentials with refreshed access token
    // Keep the same refresh token unless a new one is provided
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

export const WORDPRESSCOM = new WordPressCom();
