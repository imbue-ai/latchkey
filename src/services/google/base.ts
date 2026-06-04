/**
 * Shared base class and helpers for Google OAuth services.
 *
 * Each concrete Google service (Gmail, Drive, etc.) extends GoogleService
 * and provides its own API, scopes, and credential check endpoint.
 * The OAuth / browser-prepare flow is self-contained per service.
 */

import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Browser, BrowserContext, Locator, Page, Response } from 'playwright';
import { type ApiCredentials, OAuthCredentials } from '../../apiCredentials/base.js';
import { extractUrlFromCurlArguments } from '../../curl.js';
import {
  showSpinnerPage,
  withTempBrowserContext,
  typeLikeHuman,
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
} from '../core/base.js';
import type { EncryptedStorage } from '../../encryptedStorage.js';
import { DEFAULT_APP_NAME_PREFIX } from '../../config.js';

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

  injectIntoCurlCall(curlArguments: readonly string[]): Promise<readonly string[]> {
    const url = extractUrlFromCurlArguments(curlArguments as string[]);
    if (!url?.startsWith('https://') || !url.includes('.googleapis.com')) {
      return Promise.resolve(curlArguments);
    }
    return Promise.resolve(['-H', `X-Goog-Api-Key: ${this.apiKey}`, ...curlArguments]);
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

const DEFAULT_TIMEOUT_MS = 12000;
const LOGIN_TIMEOUT_MS = 120000;
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/**
 * Timeout for the readiness race on the project selector page: how long we
 * give either a recent-project card or the Terms of Service dialog to appear
 * before deciding that neither will.
 */
const PROJECT_SELECTOR_READINESS_TIMEOUT_MS = 3000;

/**
 * How long to give the user to read the Terms of Service and click
 * "Agree and continue" before timing out.
 */
const TERMS_OF_SERVICE_USER_INTERACTION_TIMEOUT_MS = 10 * 60 * 1000;

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

/**
 * Escape a string for safe inclusion inside a `RegExp` literal.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Look for an existing Latchkey project for this service on the project
 * selector page and open it if one is found.
 *
 * Google caps the number of projects per account, so we reuse a previously
 * created Latchkey project whenever possible instead of allocating a new one
 * just to host another OAuth client. Each service (gmail, docs, sheets, ...)
 * has its own per-service projects (named `Latchkey-...-<serviceSuffix>`),
 * so we only reuse projects that match this service's suffix; the consent
 * screen, enabled APIs, and test users are already configured the right way
 * for the current service in that case.
 *
 * Returns the project slug from the URL after navigating into the project, or
 * `null` if the recent-projects grid has no matching entry.
 */
async function findExistingLatchkeyProject(
  page: Page,
  serviceSuffix: string,
  appNamePrefix: string,
  spinnerPage: Page | null
): Promise<string | null> {
  await page.goto('https://console.cloud.google.com/projectselector2/home/dashboard', {
    timeout: DEFAULT_TIMEOUT_MS,
  });

  // The create-project button is always present, so use it as the page-ready
  // signal before we look for recent-project cards.
  const createProjectButton = page.locator('.projectselector-project-create');
  await createProjectButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });

  // Race two mutually exclusive signals so we don't pay a fixed delay in
  // the common case:
  //   * a recent-project card shows up (the original readiness signal), or
  //   * the first-time-user Terms of Service dialog appears.
  // `cfc-tos-checkboxes` is a custom element name used by the Cloud Console
  // and is locale-independent, unlike the visible "Terms of Service" text.
  const anyProjectTitle = page.locator('.cfc-resource-card-header-title').first();
  const termsOfServiceDialog = page.locator('cfc-tos-checkboxes');
  // `Promise.any` resolves with the first signal that fires and only rejects
  // when both time out — which is exactly the "either one ends the wait"
  // semantics we want here.
  let firstSignal: 'projectCard' | 'termsOfService' | 'neither';
  try {
    firstSignal = await Promise.any([
      anyProjectTitle
        .waitFor({ state: 'visible', timeout: PROJECT_SELECTOR_READINESS_TIMEOUT_MS })
        .then(() => 'projectCard' as const),
      termsOfServiceDialog
        .waitFor({ state: 'visible', timeout: PROJECT_SELECTOR_READINESS_TIMEOUT_MS })
        .then(() => 'termsOfService' as const),
    ]);
  } catch {
    firstSignal = 'neither';
  }

  if (firstSignal === 'termsOfService') {
    // If Google is asking for TOS acceptance, this is the user's first time
    // on Google Cloud and they can't possibly have any existing projects to
    // reuse — wait for acceptance and then go straight to creating one.
    await waitForTermsOfServiceAcceptance(page, termsOfServiceDialog, spinnerPage);
    return null;
  }
  if (firstSignal === 'neither') {
    // No projects and no TOS dialog: account simply has nothing to reuse.
    return null;
  }

  // Once the grid is populated, give Angular only a short window to settle
  // before deciding whether a card matching this service's suffix is among
  // them. The `.*` keeps matching legacy projects whose names still embed a
  // date/random segment between the prefix and the service suffix, so both the
  // new ("Latchkey-calendar") and legacy ("Latchkey-06-01-ab-calendar") naming
  // schemes match.
  //
  // We accept either the configured (possibly overridden) prefix or the
  // literal default "Latchkey" prefix: a project may have been created before
  // the override was configured, and reusing it is still preferable to
  // allocating a new one against Google's per-account project cap.
  const prefixes = [...new Set([appNamePrefix, DEFAULT_APP_NAME_PREFIX])];
  const prefixAlternation = prefixes.map(escapeRegExp).join('|');
  const suffixPattern = new RegExp(
    `^\\s*(?:${prefixAlternation}).*${escapeRegExp(serviceSuffix)}\\s*$`
  );
  const latchkeyTitle = page
    .locator('.cfc-resource-card-header-title')
    .filter({ hasText: suffixPattern })
    .first();
  try {
    await latchkeyTitle.waitFor({ state: 'visible', timeout: 500 });
  } catch {
    return null;
  }

  const card = latchkeyTitle.locator('xpath=ancestor::mat-card').first();
  await card.click();

  await page.waitForURL('https://console.cloud.google.com/home/dashboard?project=**', {
    timeout: 32000,
  });
  const urlObj = new URL(page.url());
  const projectId = urlObj.searchParams.get('project');
  if (!projectId) {
    throw new LoginFailedError(
      'Failed to retrieve project ID after selecting an existing Latchkey project.'
    );
  }
  return projectId;
}

async function createProject(page: Page, appName: string): Promise<string> {
  await page.goto('https://console.cloud.google.com/projectselector2/home/dashboard', {
    timeout: DEFAULT_TIMEOUT_MS,
  });

  const createProjectButton = page.locator('.projectselector-project-create');
  await createProjectButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await createProjectButton.click();

  const projectNameInput = page.locator('proj-name-id-input input');
  await projectNameInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await projectNameInput.clear();
  await typeLikeHuman(page, projectNameInput, appName);

  await new Promise((resolve) => setTimeout(resolve, 300));

  // Angular form sometimes fails to commit the typed value to its internal
  // state, causing submit to report "fields not correct" even though the
  // input is visibly populated. Deleting and retyping the last character
  // forces the form state to update.
  const lastChar = appName.slice(-1);
  await projectNameInput.press('End');
  await projectNameInput.press('Backspace');
  await projectNameInput.pressSequentially(lastChar);

  const createButton = page.locator('button[type="submit"]');
  await createButton.click();

  await page.waitForURL('https://console.cloud.google.com/home/dashboard?project=**', {
    timeout: 32000,
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

interface BrandingResult {
  /** Whether the OAuth app was set up as External (true for personal Google accounts). */
  isExternalApp: boolean;
  /** The support email selected during branding (also the signed-in user's email for personal accounts). */
  supportEmail: string;
}

async function configureBranding(
  page: Page,
  projectSlug: string,
  appName: string
): Promise<BrandingResult> {
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

  // Workspace accounts can pick "Internal"; personal accounts have it disabled
  // and must use "External". Pick the first non-disabled radio either way.
  // We detect External by checking whether the first (Internal) radio is disabled,
  // because External apps need test users added later.
  const internalRadio = page.locator('.mdc-radio').nth(0);
  await internalRadio.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  const isExternalApp: boolean = await internalRadio.evaluate(
    (el: { classList: { contains(name: string): boolean } }): boolean =>
      el.classList.contains('mdc-radio--disabled')
  );
  const audienceRadio = page.locator('.mdc-radio:not(.mdc-radio--disabled)').first();
  await audienceRadio.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await audienceRadio.click();
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

  return { isExternalApp, supportEmail: supportEmailValue ?? '' };
}

/**
 * Add a test user to the OAuth consent screen audience.
 *
 * External OAuth apps start in "Testing" mode, where only emails listed as
 * test users can complete the OAuth flow — otherwise Google blocks with
 * "Access blocked: app has not completed verification". Internal apps don't
 * need this.
 */
async function addTestUser(page: Page, projectSlug: string, email: string): Promise<void> {
  await page.goto(`https://console.cloud.google.com/auth/audience?project=${projectSlug}`, {
    timeout: DEFAULT_TIMEOUT_MS,
  });

  const addUsersButton = page.getByRole('button', { name: /add users/i }).first();
  await addUsersButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await addUsersButton.click();

  const usersInput = page.locator('mat-chip-grid input').first();
  await usersInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await typeLikeHuman(page, usersInput, email);
  await usersInput.press('Enter');

  // Wait for the email to materialize as a mat-chip-row in the grid before
  // submitting — otherwise Save can fire while Angular still considers the
  // form empty.
  const chipRow = page.locator(`mat-chip-row:has-text("${email}")`).first();
  await chipRow.waitFor({ timeout: DEFAULT_TIMEOUT_MS });

  const saveButton = page.locator('button[aria-label="Save"][type="submit"]').first();
  await saveButton.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS });
  // Try a normal click first — but Angular often needs a beat after the chip
  // is added before submit is wired up, so this first click frequently
  // no-ops. The 5s wait below gives Angular that beat; if the dialog still
  // isn't closing, fall back to a direct DOM .click() which then submits.
  await saveButton.click();
  try {
    await usersInput.waitFor({ state: 'hidden', timeout: 5000 });
  } catch {
    await saveButton.evaluate((el) => {
      (el as unknown as { click(): void }).click();
    });
    await usersInput.waitFor({ state: 'hidden', timeout: DEFAULT_TIMEOUT_MS });
  }
}

/**
 * Build a short, unique OAuth client display name.
 *
 * A single project can host many OAuth clients, so each client needs its own
 * distinct name. Keep it short (Google's OAuth client name field is tight) and
 * include a random tag to avoid collisions when reusing an existing project.
 */
function generateOAuthClientName(serviceSuffix: string, appNamePrefix: string): string {
  const randomTag = randomUUID().slice(0, 8);
  const suffix = serviceSuffix.replace(/^-+/, '');
  return `${appNamePrefix}-${suffix}-${randomTag}`;
}

async function createOAuthClient(
  page: Page,
  serviceSuffix: string,
  appNamePrefix: string
): Promise<{ clientId: string; clientSecret: string }> {
  const clientName = generateOAuthClientName(serviceSuffix, appNamePrefix);

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
  await clientNameInput.fill(clientName);

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
      void response
        .text()
        .then((text) => {
          if (!text.includes('accounts.google.com/signin')) {
            loginDetector.isLoggedIn = true;
          }
        })
        .catch((error: unknown) => {
          // The response body can become unreadable if the page/context
          // closes while it's still being read (e.g. the automation
          // navigates onward, or the user closes the browser). Treat that
          // specific race as inconclusive; let any other error propagate.
          if (error instanceof Error && isBrowserClosedError(error)) {
            return;
          }
          throw error;
        });
    }
  }
}

/**
 * When a Google account signs in to the Cloud Console for the first time,
 * Google displays a Terms of Service dialog on top of the page that blocks
 * every subsequent interaction with the console.
 *
 * Surface the login page so the user can read and accept the terms, then
 * restore the spinner page once the dialog is dismissed.
 */
async function waitForTermsOfServiceAcceptance(
  loginPage: Page,
  dialog: Locator,
  spinnerPage: Page | null
): Promise<void> {
  await loginPage.bringToFront();
  try {
    await dialog.waitFor({
      state: 'detached',
      timeout: TERMS_OF_SERVICE_USER_INTERACTION_TIMEOUT_MS,
    });
  } catch (error: unknown) {
    if (error instanceof Error && isBrowserClosedError(error)) {
      throw new LoginCancelledError();
    }
    throw error;
  }

  if (spinnerPage !== null) {
    await spinnerPage.bringToFront();
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
  /** The Google API identifiers to enable (e.g., ['gmail.googleapis.com']). */
  readonly apis: readonly string[];
  /** OAuth scopes required by this service. */
  readonly scopes: readonly string[];
}

class GoogleServiceSession extends BrowserFollowupServiceSession {
  private readonly loginDetector = { isLoggedIn: false };
  private readonly config: GoogleServiceConfig;

  constructor(service: GoogleService, config: GoogleServiceConfig, appNamePrefix: string) {
    super(service, appNamePrefix);
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

      const serviceSuffix = this.service.name.replace(/^google/, '');

      const spinnerPage = await showSpinnerPage(
        context,
        `Finalizing ${this.service.displayName} login by using Google Console to set up the project for custom authentication...\nThis can take a few minutes.`
      );

      // Google caps the number of projects per account, so try to reuse a
      // previously created Latchkey project for this service before
      // allocating a new one. This also detects the first-time-user Terms of
      // Service dialog and surfaces it to the user when needed.
      const existingProjectSlug = await findExistingLatchkeyProject(
        page,
        serviceSuffix,
        this.appNamePrefix,
        spinnerPage
      );
      let projectSlug: string;
      if (existingProjectSlug === null) {
        // Use a deterministic project name (e.g. "Latchkey-gmail") rather than
        // one with date/random bits: projects are now reused per service, so a
        // stable name keeps the reuse lookup predictable. Google still derives
        // a globally-unique project ID from this display name on its own.
        const appName = `${this.appNamePrefix}${serviceSuffix}`;
        // Google limits the OAuth project name to 30 characters.
        if (appName.length > 30) {
          throw new LoginFailedError(
            `Generated app name "${appName}" exceeds Google OAuth project name limit of 30 characters.`
          );
        }
        projectSlug = await createProject(page, appName);
        const { isExternalApp, supportEmail } = await configureBranding(page, projectSlug, appName);
        if (isExternalApp && supportEmail) {
          await addTestUser(page, projectSlug, supportEmail);
        }
      } else {
        projectSlug = existingProjectSlug;
      }

      // Always make sure every required API is enabled, whether the project was
      // just created or reused. A reused project might be a half-configured
      // leftover from a previous run that crashed before all APIs were turned
      // on; enableApi is idempotent and returns immediately when an API is
      // already enabled, so re-running it is cheap and self-healing.
      for (const api of this.config.apis) {
        await enableApi(page, projectSlug, api);
      }

      const { clientId, clientSecret } = await createOAuthClient(
        page,
        serviceSuffix,
        this.appNamePrefix
      );
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

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
  }

  override getSession(appNamePrefix: string): GoogleServiceSession {
    return new GoogleServiceSession(this, this.config, appNamePrefix);
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
        tokens.refresh_token ?? apiCredentials.refreshToken,
        accessTokenExpiresAt,
        apiCredentials.refreshTokenExpiresAt
      )
    );
  }
}
