/**
 * Shared base class and helpers for Google OAuth services.
 *
 * Each concrete Google service (Gmail, Drive, etc.) extends GoogleService
 * and provides its own API, scopes, and credential check endpoint.
 * The OAuth / browser-prepare flow is self-contained per service.
 */

import fs from 'node:fs/promises';
import { z } from 'zod';
import type { Browser, BrowserContext, Page, Response } from 'playwright';
import { type ApiCredentials, OAuthCredentials } from '../../apiCredentials.js';
import { extractUrlFromCurlArguments } from '../../curl.js';
import {
  generateLatchkeyAppName,
  showSpinnerPage,
  withTempBrowserContext,
  type BrowserLaunchOptions,
} from '../../playwrightUtils.js';
import {
  exchangeCodeForTokens,
  refreshAccessToken,
  startOAuthCallbackServer,
} from '../../oauthUtils.js';
import {
  Service,
  BrowserFollowupServiceSession,
  LoginFailedError,
  LoginCancelledError,
  isBrowserClosedError,
} from '../base.js';
import type { EncryptedStorage } from '../../encryptedStorage.js';

/**
 * Google API key credentials.
 * The API key is injected as an `X-Goog-Api-Key` header.
 */
export const GoogleApiKeyCredentialsSchema = z.object({
  objectType: z.literal('googleApiKey'),
  apiKey: z.string(),
});

export type GoogleApiKeyCredentialsData = z.infer<typeof GoogleApiKeyCredentialsSchema>;

export class GoogleApiKeyCredentials implements ApiCredentials {
  readonly objectType = 'googleApiKey' as const;
  readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  injectIntoCurlCall(curlArguments: readonly string[]): readonly string[] {
    const url = extractUrlFromCurlArguments(curlArguments as string[]);
    if (!url?.startsWith('https://') || !url.includes('.googleapis.com')) {
      return curlArguments;
    }
    return ['-H', `X-Goog-Api-Key: ${this.apiKey}`, ...curlArguments];
  }

  isExpired(): boolean | undefined {
    return undefined;
  }

  toJSON(): GoogleApiKeyCredentialsData {
    return {
      objectType: this.objectType,
      apiKey: this.apiKey,
    };
  }

  static fromJSON(data: GoogleApiKeyCredentialsData): GoogleApiKeyCredentials {
    return new GoogleApiKeyCredentials(data.apiKey);
  }
}

const DEFAULT_TIMEOUT_MS = 8000;
const LOGIN_TIMEOUT_MS = 120000;
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** Scopes always requested alongside service-specific scopes (for credential validation). */
const COMMON_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email',
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

async function createProject(page: Page, appName: string): Promise<string> {
  await page.goto('https://console.cloud.google.com/projectselector2/home/dashboard', {
    timeout: DEFAULT_TIMEOUT_MS,
  });

  const createProjectButton = page.locator('.projectselector-project-create');
  await createProjectButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await createProjectButton.click();

  const projectNameInput = page.locator('proj-name-id-input input');
  await projectNameInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS * 100 });
  await projectNameInput.fill(appName);

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

async function enableApi(page: Page, projectSlug: string, apiName: string): Promise<void> {
  await page.goto(
    `https://console.cloud.google.com/apis/library/${apiName}?project=${projectSlug}`,
    {
      timeout: DEFAULT_TIMEOUT_MS,
    }
  );

  const successIcon = page.locator('.cfc-icon-status-success');
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

async function configureBranding(page: Page, projectSlug: string, appName: string): Promise<void> {
  await page.goto(`https://console.cloud.google.com/auth/branding?project=${projectSlug}`, {
    timeout: DEFAULT_TIMEOUT_MS,
  });
  const getStartedButton = page.locator('cfc-empty-state-actions .mdc-button__label');
  await getStartedButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await getStartedButton.click();
  const appNameInput = page.locator('input[formcontrolname="displayName"]');
  await appNameInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await appNameInput.fill(appName);
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

async function createOAuthClient(
  page: Page,
  appName: string
): Promise<{ clientId: string; clientSecret: string }> {
  await page.goto('https://console.cloud.google.com/apis/credentials', {
    timeout: DEFAULT_TIMEOUT_MS,
  });

  const createCredentialsButton = page.locator('services-create-credentials-menu button');
  await createCredentialsButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await createCredentialsButton.click();

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
  await clientNameInput.fill(appName);

  const createButton = page.locator('cfc-progress-button button');
  await createButton.click();

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
  if (request.url().startsWith('https://console.cloud.google.com/')) {
    if (response.status() === 200) {
      void response.text().then((text) => {
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

/**
 * Configuration for a specific Google API service.
 */
export interface GoogleServiceConfig {
  /** The Google API identifier (e.g., 'gmail.googleapis.com'). */
  readonly api: string;
  /** OAuth scopes required by this service. */
  readonly scopes: readonly string[];
}

class GoogleServiceSession extends BrowserFollowupServiceSession {
  private readonly loginDetector = { isLoggedIn: false };
  private readonly config: GoogleServiceConfig;

  constructor(service: GoogleService, config: GoogleServiceConfig) {
    super(service);
    this.config = config;
  }

  onResponse(response: Response): void {
    checkGoogleLoginResponse(response, this.loginDetector);
  }

  protected isLoginComplete(): boolean {
    return this.loginDetector.isLoggedIn;
  }

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

    if (!(oldCredentials instanceof OAuthCredentials)) {
      throw new LoginFailedError(
        `${this.service.displayName} login requires existing OAuth client credentials. Run browser-prepare first.`
      );
    }

    const clientId = oldCredentials.clientId;
    const clientSecret = oldCredentials.clientSecret;

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

      const appName = generateLatchkeyAppName();

      await showSpinnerPage(
        context,
        `Finalizing ${this.service.displayName} login...\nThis can take a few minutes.`
      );
      const projectSlug = await createProject(page, appName);
      await enableApi(page, projectSlug, this.config.api);
      await configureBranding(page, projectSlug, appName);
      const { clientId, clientSecret } = await createOAuthClient(page, appName);
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
    const abortController = new AbortController();
    const closeHandler = () => {
      abortController.abort();
    };
    page.on('close', closeHandler);
    context.on('close', closeHandler);

    const allScopes = [...COMMON_SCOPES, ...this.config.scopes];

    try {
      const { port, codePromise } = await startOAuthCallbackServer(
        LOGIN_TIMEOUT_MS,
        abortController.signal
      );
      const redirectUri = `http://localhost:${port.toString()}/oauth2callback`;

      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', allScopes.join(' '));
      authUrl.searchParams.set('access_type', 'offline');
      authUrl.searchParams.set('prompt', 'consent');

      await page.goto(authUrl.toString());

      const code = await codePromise;
      const tokens = exchangeCodeForTokens(
        GOOGLE_TOKEN_ENDPOINT,
        code,
        clientId,
        clientSecret,
        redirectUri
      );
      const accessTokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

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
      page.off('close', closeHandler);
      context.off('close', closeHandler);
    }
  }
}

/**
 * Abstract base class for individual Google API services.
 *
 * Each subclass declares the specific API, scopes, and credential-check endpoint
 * it needs. The OAuth and browser-prepare flows are handled here and scoped
 * to that single API.
 */
export abstract class GoogleService extends Service {
  readonly loginUrl = 'https://console.cloud.google.com/';

  protected abstract readonly config: GoogleServiceConfig;

  override getSession(): GoogleServiceSession {
    return new GoogleServiceSession(this, this.config);
  }

  override refreshCredentials(apiCredentials: ApiCredentials): Promise<ApiCredentials | null> {
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

    const accessTokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

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
