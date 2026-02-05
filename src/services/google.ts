/**
 * Google service implementation with OAuth flow.
 */

import type { Response, BrowserContext, Page } from 'playwright';
import { ApiCredentialStatus, ApiCredentials, OAuthCredentials } from '../apiCredentials.js';
import { generateLatchkeyAppName } from '../playwrightUtils.js';
import { runCaptured } from '../curl.js';
import { Service, BrowserFollowupServiceSession, LoginFailedError } from './base.js';
import * as http from 'node:http';
import * as url from 'node:url';

const DEFAULT_TIMEOUT_MS = 8000;
const OAUTH_CALLBACK_PORT = 8080;
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
  refresh_token: string;
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

class GoogleServiceSession extends BrowserFollowupServiceSession {
  private isLoggedIn = false;

  onResponse(response: Response): void {
    if (this.isLoggedIn) {
      return;
    }

    const request = response.request();
    // Detect successful login by checking for Google account access
    if (request.url().startsWith('https://console.cloud.google.com/')) {
      if (response.status() === 200) {
        void response.text().then((text) => {
          // Check if we're actually logged in (not on login page)
          if (!text.includes('accounts.google.com/signin')) {
            this.isLoggedIn = true;
          }
        });
      }
    }
  }

  protected isLoginComplete(): boolean {
    return this.isLoggedIn;
  }

  protected async performBrowserFollowup(
    context: BrowserContext,
    oldCredentials?: ApiCredentials
  ): Promise<ApiCredentials | null> {
    const page = context.pages()[0];
    if (!page) {
      throw new LoginFailedError('No page available in browser context.');
    }

    let clientId: string;
    let clientSecret: string;

    // Try to reuse existing client ID and secret from old credentials
    if (oldCredentials instanceof OAuthCredentials) {
      clientId = oldCredentials.clientId;
      clientSecret = oldCredentials.clientSecret;
    } else {
      // Step 1: Navigate to Google Cloud Console and create project
      const projectSlug = await this.createProject(page);

      // Step 2: Enable required APIs
      await this.enableGoogleApis(page, projectSlug);

      // Step 3: Create OAuth client ID
      await this.configureBranding(page, projectSlug);
      const credentials = await this.createOAuthClient(page);
      clientId = credentials.clientId;
      clientSecret = credentials.clientSecret;
    }

    // Step 4: Perform OAuth flow with localhost server
    const { accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt } =
      await this.performOAuthFlow(page, clientId, clientSecret);

    await page.close();

    return new OAuthCredentials(
      accessToken,
      refreshToken,
      clientId,
      clientSecret,
      accessTokenExpiresAt,
      refreshTokenExpiresAt
    );
  }

  private async createProject(page: Page): Promise<string> {
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

  private async enableGoogleApis(page: Page, projectSlug: string): Promise<void> {
    const apis = [
      'gmail.googleapis.com',
      'calendar-json.googleapis.com',
      'drive.googleapis.com',
      'sheets.googleapis.com',
      'docs.googleapis.com',
      'people.googleapis.com', // Contacts API
    ];

    for (const api of apis) {
      await this.enableApi(page, projectSlug, api);
    }
  }

  private async enableApi(page: Page, projectSlug: string, apiName: string): Promise<void> {
    await page.goto(`https://console.cloud.google.com/apis/library/${apiName}?project=${projectSlug}`, {
      timeout: DEFAULT_TIMEOUT_MS,
    });

    const manageButton = page.locator('text="Manage"');
    const enableButton = page.locator('.mp-details-cta-button-primary button .mdc-button__label').filter({ visible: true });

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

  private async configureBranding(page: Page, projectSlug: string) {
    await page.goto(`https://console.cloud.google.com/auth/branding?project=${projectSlug}`, {
        timeout: DEFAULT_TIMEOUT_MS,
    });
    const getStartedButton = page.locator('cfc-empty-state-actions .mdc-button__label');
    await getStartedButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await getStartedButton.click();
    const appNameInput = page.locator('input[formcontrolname="displayName"]');
    await appNameInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await appNameInput.fill(await generateLatchkeyAppName());
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
    nextButton.click();

    const createButton = page.locator('.cfc-stepper-submit-button button');
    await createButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await createButton.click();
  }

  private async createOAuthClient(page: Page): Promise<{ clientId: string; clientSecret: string }> {
    // Navigate to credentials page
    await page.goto('https://console.cloud.google.com/apis/credentials', {
      timeout: DEFAULT_TIMEOUT_MS,
    });

    // Click "Create Credentials" button
    const createCredentialsButton = page.locator('button:has-text("Create Credentials")');
    await createCredentialsButton.click();

    // Click "OAuth client ID"
    const oauthClientIdOption = page.locator('text="OAuth client ID"');
    await oauthClientIdOption.click();

    const configureConsentButton = page.locator('button:has-text("Configure consent screen")');
    const applicationTypeDropdown = page.locator('[aria-label="Application type"]');
    const applicationTypeOrConfigureConsentButton = configureConsentButton.or(applicationTypeDropdown);

    await applicationTypeOrConfigureConsentButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });

    if (await configureConsentButton.isVisible()) {
        await configureConsentButton.click();

    }

    // Select "Desktop app" as application type
    await applicationTypeDropdown.click();

    const desktopAppOption = page.locator('text="Desktop app"');
    await desktopAppOption.click();

    // Fill in name
    const nameInput = page.locator('input[aria-label="Name"]');
    await nameInput.fill('Latchkey OAuth Client');

    // Click Create
    const createButton = page.locator('button:has-text("Create")');
    await createButton.click();

    // Wait for the credentials to be created
    await page.waitForTimeout(3000);

    // Download the JSON file
    const downloadButton = page.locator('button:has-text("Download JSON")');
    if (await downloadButton.isVisible({ timeout: 5000 })) {
      const [download] = await Promise.all([page.waitForEvent('download'), downloadButton.click()]);

      const path = await download.path();
      if (!path) {
        throw new LoginFailedError('Failed to download client_secret.json');
      }

      const fs = await import('node:fs/promises');
      const content = await fs.readFile(path, 'utf-8');

      return parseClientSecretJson(content);
    }

    throw new LoginFailedError('Failed to create OAuth client credentials.');
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
    const redirectUri = `http://localhost:${OAUTH_CALLBACK_PORT.toString()}/oauth2callback`;

    // Start the callback server
    const serverPromise = startOAuthCallbackServer(OAUTH_CALLBACK_PORT, 120000);

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
}

export const GOOGLE = new Google();
