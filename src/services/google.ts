/**
 * Google service implementation with OAuth flow.
 */

import fs from 'node:fs/promises';
import type { Browser, BrowserContext, Page, Response } from 'playwright';
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
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const APIS = [
  'gmail.googleapis.com',
  'calendar-json.googleapis.com',
  'drive.googleapis.com',
  'sheets.googleapis.com',
  'docs.googleapis.com',
  'people.googleapis.com', // Contacts API
];
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

async function enableApis(page: Page, projectSlug: string): Promise<void> {
  for (const api of APIS) {
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

  const successIcon = page.locator('.cfc-icon-status-success'); // Present when API is already enabled.
  const enableButton = page
    .locator('.mp-details-cta-button-primary button .mdc-button__label')
    .filter({ visible: true });
  const sucessOrEnableButton = successIcon.or(enableButton);
  await sucessOrEnableButton.isVisible({ timeout: DEFAULT_TIMEOUT_MS });

  if (await successIcon.isVisible()) {
    return;
  }

  await enableButton.click();
  const stopIndicator = page.locator('.cfc-icon-stop');
  await stopIndicator.waitFor({ timeout: 18000 });
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

  /**
   * Override to skip the spinner page since the OAuth flow requires user interaction
   * (granting consent on Google's authorization page).
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
        'Google login requires existing OAuth client credentials. Run prepare first.'
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

  override async prepare(
    encryptedStorage: EncryptedStorage,
    launchOptions?: BrowserLaunchOptions
  ): Promise<ApiCredentials> {
    return withTempBrowserContext(encryptedStorage, launchOptions ?? {}, async ({ context }) => {
      const page = await context.newPage();
      await page.goto(this.service.loginUrl);
      await waitForGoogleLogin(page);

      await showSpinnerPage(
        context,
        `Finalizing ${this.service.displayName} login...\nThis can take a few minutes.`
      );
      const projectSlug = await createProject(page);
      await enableApis(page, projectSlug);
      await configureBranding(page, projectSlug);
      const { clientId, clientSecret } = await createOAuthClient(page);
      await page.close();
      return new OAuthCredentials(clientId, clientSecret);
    });
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
      // Start the callback server first to get the auto-assigned port
      const { port, codePromise } = await startOAuthCallbackServer(
        LOGIN_TIMEOUT_MS,
        abortController.signal
      );
      const redirectUri = `http://localhost:${port.toString()}/oauth2callback`;

      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', OAUTH_SCOPES.join(' '));
      authUrl.searchParams.set('access_type', 'offline');
      authUrl.searchParams.set('prompt', 'consent');

      await page.goto(authUrl.toString());

      // Wait for the authorization code from the callback
      const code = await codePromise;
      const tokens = exchangeCodeForTokens(
        GOOGLE_TOKEN_ENDPOINT,
        code,
        clientId,
        clientSecret,
        redirectUri
      );
      const accessTokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

      // Google refresh tokens typically don't expire, so we don't set refreshTokenExpiresAt
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        accessTokenExpiresAt,
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

export class Google implements Service {
  readonly name = 'google';
  readonly displayName = 'Google Workspace';
  readonly baseApiUrls = ['https://www.googleapis.com/'] as const;
  readonly loginUrl = 'https://console.cloud.google.com/';
  readonly info =
    'Supports some Google Workspace APIs: Gmail, Calendar, Drive, Sheets, Docs, and Contacts. ' +
    'If needed, run "latchkey prepare google" to create an OAuth client first. ' +
    'It may take a few minutes before the OAuth client is ready to use.';

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

  refreshCredentials(apiCredentials: ApiCredentials): Promise<ApiCredentials | null> {
    if (!(apiCredentials instanceof OAuthCredentials)) {
      return Promise.resolve(null);
    }

    if (!apiCredentials.refreshToken) {
      return Promise.resolve(null);
    }

    const tokens = refreshAccessToken(
      GOOGLE_TOKEN_ENDPOINT,
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
        tokens.refresh_token,
        accessTokenExpiresAt,
        apiCredentials.refreshTokenExpiresAt
      )
    );
  }
}

export const GOOGLE = new Google();
