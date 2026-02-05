/**
 * Google service implementation with OAuth flow.
 */

import type { Response, BrowserContext, Page } from 'playwright';
import { ApiCredentialStatus, ApiCredentials, OAuthCredentials } from '../apiCredentials.js';
import {
  generateLatchkeyAppName,
  withTempBrowserContext,
  type BrowserLaunchOptions,
} from '../playwrightUtils.js';
import { runCaptured } from '../curl.js';
import { Service, BrowserFollowupServiceSession, LoginFailedError } from './base.js';
import type { EncryptedStorage } from '../encryptedStorage.js';
import * as http from 'node:http';
import * as url from 'node:url';

const DEFAULT_TIMEOUT_MS = 8000;
const OAUTH_SCOPES = [
  // User info (for credential validation)
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email',
  // Gmail API
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  // Calendar API
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  // Drive API
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.file',
  // Sheets API
  'https://www.googleapis.com/auth/spreadsheets',
  // Docs API
  'https://www.googleapis.com/auth/documents',
  // Contacts API
  'https://www.googleapis.com/auth/contacts',
  'https://www.googleapis.com/auth/contacts.readonly',
] as const;

interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

interface ClientSecretJson {
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
  web?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
}

class OAuthCallbackServerTimeoutError extends Error {
  constructor() {
    super('OAuth callback server timed out waiting for authorization code.');
    this.name = 'OAuthCallbackServerTimeoutError';
  }
}

class OAuthTokenExchangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthTokenExchangeError';
  }
}

class PortUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortUnavailableError';
  }
}

/**
 * Find an available port starting from the specified port.
 * Tries ports sequentially until it finds one that's available.
 */
async function findAvailablePort(startPort: number, maxAttempts = 10): Promise<number> {
  for (let port = startPort; port < startPort + maxAttempts; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const testServer = http.createServer();

        testServer.once('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'EADDRINUSE') {
            reject(error);
          } else {
            reject(error);
          }
        });

        testServer.once('listening', () => {
          testServer.close(() => {
            resolve();
          });
        });

        testServer.listen(port, 'localhost');
      });

      return port;
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') {
        continue;
      }
      throw error;
    }
  }

  throw new PortUnavailableError(
    `Could not find an available port in range ${startPort.toString()}-${(startPort + maxAttempts - 1).toString()}`
  );
}

/**
 * Start a temporary HTTP server to receive OAuth callback.
 * Returns a promise that resolves with the authorization code.
 */
function startOAuthCallbackServer(
  port: number,
  timeoutMs: number
): Promise<{ code: string; server: http.Server }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const parsedUrl = url.parse(req.url ?? '', true);

      if (parsedUrl.pathname === '/oauth2callback') {
        const code = parsedUrl.query.code as string | undefined;

        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <!DOCTYPE html>
            <html>
              <head><title>Authorization Successful</title></head>
              <body>
                <h1>Authorization successful!</h1>
                <p>You can close this window and return to the terminal.</p>
              </body>
            </html>
          `);
          resolve({ code, server });
        } else {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`
            <!DOCTYPE html>
            <html>
              <head><title>Authorization Failed</title></head>
              <body>
                <h1>Authorization failed</h1>
                <p>No authorization code received.</p>
              </body>
            </html>
          `);
          reject(new LoginFailedError('No authorization code received from OAuth callback.'));
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    const timeout = setTimeout(() => {
      server.close();
      reject(new OAuthCallbackServerTimeoutError());
    }, timeoutMs);

    server.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    server.listen(port, 'localhost', () => {
      // Server is listening
    });
  });
}

/**
 * Exchange authorization code for access and refresh tokens.
 */
function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): OAuthTokenResponse {
  const tokenEndpoint = 'https://oauth2.googleapis.com/token';
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const result = runCaptured(
    [
      '-s',
      '-X',
      'POST',
      '-H',
      'Content-Type: application/x-www-form-urlencoded',
      '-d',
      body.toString(),
      tokenEndpoint,
    ],
    30
  );

  if (result.returncode !== 0) {
    throw new OAuthTokenExchangeError(
      `Failed to exchange authorization code for tokens: ${result.stderr}`
    );
  }

  try {
    const response = JSON.parse(result.stdout) as OAuthTokenResponse;
    if (!response.access_token || !response.refresh_token) {
      throw new OAuthTokenExchangeError('Token response missing access_token or refresh_token.');
    }
    return response;
  } catch (error: unknown) {
    if (error instanceof OAuthTokenExchangeError) {
      throw error;
    }
    throw new OAuthTokenExchangeError(
      `Failed to parse token response: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Refresh OAuth access token using the refresh token.
 */
function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): OAuthTokenResponse | null {
  const tokenEndpoint = 'https://oauth2.googleapis.com/token';
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  });

  const result = runCaptured(
    [
      '-s',
      '-X',
      'POST',
      '-H',
      'Content-Type: application/x-www-form-urlencoded',
      '-d',
      body.toString(),
      tokenEndpoint,
    ],
    30
  );

  if (result.returncode !== 0) {
    return null;
  }

  try {
    const response = JSON.parse(result.stdout) as OAuthTokenResponse;
    if (!response.access_token) {
      return null;
    }
    return response;
  } catch {
    return null;
  }
}

/**
 * Parse client_secret.json content.
 */
function parseClientSecretJson(content: string): { clientId: string; clientSecret: string } {
  try {
    const json = JSON.parse(content) as ClientSecretJson;
    const config = json.installed ?? json.web;

    if (!config) {
      throw new LoginFailedError(
        'Invalid client_secret.json: missing "installed" or "web" configuration.'
      );
    }

    return {
      clientId: config.client_id,
      clientSecret: config.client_secret,
    };
  } catch (error: unknown) {
    if (error instanceof LoginFailedError) {
      throw error;
    }
    throw new LoginFailedError(
      `Failed to parse client_secret.json: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function createProject(page: Page): Promise<string> {
  // Navigate to the projects page
  await page.goto('https://console.cloud.google.com/projectselector2/home/dashboard', {
    timeout: DEFAULT_TIMEOUT_MS,
  });

  // Always create a new project
  const createProjectButton = page.locator('.projectselector-project-create');
  await createProjectButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await createProjectButton.click();

  const projectNameInput = page.locator('proj-name-id-input input');
  await projectNameInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS * 100 });
  await projectNameInput.fill(generateLatchkeyAppName());

  const createButton = page.locator('button[type="submit"]');
  await createButton.click();

  await page.waitForURL('https://console.cloud.google.com/home/dashboard?project=**', {
    timeout: 16000,
  });
  const urlObj = new URL(page.url());
  const projectId = urlObj.searchParams.get('project');
  if (!projectId) {
    throw new LoginFailedError('Failed to create or retrieve Google Cloud project ID.');
  }
  return projectId;
}

async function enableGoogleApis(page: Page, projectSlug: string): Promise<void> {
  const apis = [
    'gmail.googleapis.com',
    'calendar-json.googleapis.com',
    'drive.googleapis.com',
    'sheets.googleapis.com',
    'docs.googleapis.com',
    'people.googleapis.com', // Contacts API
  ];

  for (const api of apis) {
    await enableApi(page, projectSlug, api);
  }
}

async function enableApi(page: Page, projectSlug: string, apiName: string): Promise<void> {
  await page.goto(
    `https://console.cloud.google.com/apis/library/${apiName}?project=${projectSlug}`,
    {
      timeout: DEFAULT_TIMEOUT_MS,
    }
  );

  const manageButton = page.locator('text="Manage"');
  const enableButton = page
    .locator('.mp-details-cta-button-primary button .mdc-button__label')
    .filter({ visible: true });

  const manageOrEnableButton = manageButton.or(enableButton);

  await manageOrEnableButton.isVisible({ timeout: DEFAULT_TIMEOUT_MS });

  // Check if API is already enabled
  if (await manageButton.isVisible()) {
    return;
  }

  await enableButton.click();
  const disableButton = page.locator('text="Disable API"');
  await disableButton.waitFor({ timeout: 18000 });
}

async function configureBranding(page: Page, projectSlug: string): Promise<void> {
  await page.goto(`https://console.cloud.google.com/auth/branding?project=${projectSlug}`, {
    timeout: DEFAULT_TIMEOUT_MS,
  });
  const getStartedButton = page.locator('cfc-empty-state-actions .mdc-button__label');
  await getStartedButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await getStartedButton.click();
  const appNameInput = page.locator('input[formcontrolname="displayName"]');
  await appNameInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await appNameInput.fill(generateLatchkeyAppName());
  const emailSelector = page.locator('svg[data-icon-name="arrowDropDownIcon"]').nth(0);
  await emailSelector.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await emailSelector.click();
  const supportEmailOption = page.locator('mat-option > span:nth-child(1)').first();
  await supportEmailOption.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  const supportEmailValue = await supportEmailOption.textContent();
  await supportEmailOption.click();
  const nextButton = page.locator('.cfc-stepper-step-button');
  await nextButton.click();

  const internalAudienceRadio = page.locator('.mdc-radio').nth(0);
  await internalAudienceRadio.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await internalAudienceRadio.click();
  await nextButton.click();

  const contactEmailInput = page.locator('mat-chip-grid[formcontrolname="emails"] input');
  await contactEmailInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await contactEmailInput.fill(supportEmailValue ?? '');
  await nextButton.click();

  const agreeCheckbox = page.locator('input[type="checkbox"]');
  await agreeCheckbox.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await agreeCheckbox.click();
  await nextButton.click();

  const createButton = page.locator('.cfc-stepper-submit-button button');
  await createButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await createButton.click();
}

async function createOAuthClient(page: Page): Promise<{ clientId: string; clientSecret: string }> {
  // Navigate to credentials page
  await page.goto('https://console.cloud.google.com/apis/credentials', {
    timeout: DEFAULT_TIMEOUT_MS,
  });

  // Click "Create Credentials" button
  const createCredentialsButton = page.locator('services-create-credentials-menu button');
  await createCredentialsButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await createCredentialsButton.click();

  // Click "OAuth client ID"
  const oauthClientIdOption = page.locator('cfc-menu-item[track-metadata-type="OAUTH_CLIENT"]');
  await oauthClientIdOption.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await oauthClientIdOption.click();

  const applicationTypeDropdown = page.locator('svg[data-icon-name="arrowDropDownIcon"]').nth(0);
  await applicationTypeDropdown.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await applicationTypeDropdown.click();

  const desktopAppOption = page.locator('#_1rif_mat-option-5');
  await desktopAppOption.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await desktopAppOption.click();

  const clientNameInput = page.locator('input[formcontrolname="displayName"]');
  await clientNameInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await clientNameInput.fill(generateLatchkeyAppName());

  // Click Create
  const createButton = page.locator('cfc-progress-button button');
  await createButton.click();

  // Download the JSON file
  const downloadButton = page.locator('cfc-icon[icon="download"]');
  await downloadButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  const [download] = await Promise.all([page.waitForEvent('download'), downloadButton.click()]);
  const path = await download.path();
  if (!path) {
    throw new LoginFailedError('Failed to download client_secret.json');
  }

  const fs = await import('node:fs/promises');
  const content = await fs.readFile(path, 'utf-8');

  return parseClientSecretJson(content);
}

function checkGoogleLoginResponse(
  response: Response,
  loginDetector: { isLoggedIn: boolean }
): void {
  if (loginDetector.isLoggedIn) {
    return;
  }

  const request = response.request();
  // Detect successful login by checking for Google account access
  if (request.url().startsWith('https://console.cloud.google.com/')) {
    if (response.status() === 200) {
      void response.text().then((text) => {
        // Check if we're actually logged in (not on login page)
        if (!text.includes('accounts.google.com/signin')) {
          loginDetector.isLoggedIn = true;
        }
      });
    }
  }
}

async function waitForGoogleLogin(page: Page): Promise<void> {
  const loginDetector = { isLoggedIn: false };

  const responseHandler = (response: Response) => {
    checkGoogleLoginResponse(response, loginDetector);
  };

  page.on('response', responseHandler);

  while (!loginDetector.isLoggedIn) {
    await page.waitForTimeout(100);
  }

  page.off('response', responseHandler);
}

class GoogleServiceSession extends BrowserFollowupServiceSession {
  private readonly loginDetector = { isLoggedIn: false };

  onResponse(response: Response): void {
    checkGoogleLoginResponse(response, this.loginDetector);
  }

  protected isLoginComplete(): boolean {
    return this.loginDetector.isLoggedIn;
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
        'Google login requires existing OAuth client credentials. Run prepare first.'
      );
    }

    const clientId = oldCredentials.clientId;
    const clientSecret = oldCredentials.clientSecret;

    // Perform OAuth flow with localhost server
    const { accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt } =
      await this.performOAuthFlow(page, clientId, clientSecret);

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
    page: Page,
    clientId: string,
    clientSecret: string
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt?: string;
    refreshTokenExpiresAt?: string;
  }> {
    // Find an available port starting from 8080
    const port = await findAvailablePort(8080);
    const redirectUri = `http://localhost:${port.toString()}/oauth2callback`;

    // Start the callback server
    const serverPromise = startOAuthCallbackServer(port, 120000);

    // Build OAuth authorization URL
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', OAUTH_SCOPES.join(' '));
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');

    // Navigate to OAuth authorization URL
    await page.goto(authUrl.toString());

    // Wait for user to authorize and get the code
    const { code, server } = await serverPromise;

    // Close the server
    server.close();

    // Exchange code for tokens
    const tokens = exchangeCodeForTokens(code, clientId, clientSecret, redirectUri);

    // Calculate access token expiration from the expires_in field
    const accessTokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    // The refresh_token is guaranteed to be present in the authorization code flow
    // because exchangeCodeForTokens validates it
    if (!tokens.refresh_token) {
      throw new OAuthTokenExchangeError('Token response missing refresh_token.');
    }

    // Google refresh tokens typically don't expire, so we don't set refreshTokenExpiresAt
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accessTokenExpiresAt,
    };
  }
}

export class Google implements Service {
  readonly name = 'google';
  readonly baseApiUrls = ['https://www.googleapis.com/'] as const;
  readonly loginUrl = 'https://console.cloud.google.com/';

  readonly credentialCheckCurlArguments = [
    'https://www.googleapis.com/oauth2/v1/userinfo',
  ] as const;

  getSession(): GoogleServiceSession {
    return new GoogleServiceSession(this);
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

      // Navigate to Google Cloud Console login
      await page.goto(this.loginUrl);

      // Wait for user to log in
      await waitForGoogleLogin(page);

      // Create project, enable APIs, and create OAuth client
      const projectSlug = await createProject(page);
      await enableGoogleApis(page, projectSlug);
      await configureBranding(page, projectSlug);
      const { clientId, clientSecret } = await createOAuthClient(page);

      await page.close();

      // Return credentials with just client ID and secret (no tokens yet)
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
      apiCredentials.refreshToken,
      apiCredentials.clientId,
      apiCredentials.clientSecret
    );

    if (tokens === null) {
      return Promise.resolve(null);
    }

    // Calculate access token expiration from the expires_in field
    const accessTokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

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

export const GOOGLE = new Google();
