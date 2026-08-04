/**
 * Zoom service implementation.
 *
 * Browser login creates a Server-to-Server OAuth app in the Zoom App
 * Marketplace. Such an app has no user context: its credentials are an account
 * id plus a client id/secret, which are exchanged for a short-lived access
 * token with the `account_credentials` grant whenever the previous token
 * expires.
 */

import type { BrowserContext, Locator, Page, Response } from 'playwright';
import { z } from 'zod';
import { ApiCredentials, ApiCredentialsUsageError } from '../apiCredentials/base.js';
import { fetchAccountFromEndpoint, tryParseJson } from '../apiCredentials/account.js';
import { runCapturedAsync } from '../curl.js';
import { typeLikeHuman } from '../playwrightUtils.js';
import {
  BrowserFollowupServiceSession,
  FollowupWork,
  LoginFailedError,
  Service,
} from './core/base.js';

const ZOOM_TOKEN_ENDPOINT = 'https://zoom.us/oauth/token';

// The Marketplace page that lists the user's apps and carries the "Develop"
// menu the app creation flow starts from.
const ZOOM_MARKETPLACE_BUILD_URL = 'https://marketplace.zoom.us/user/build';

// Zoom's access tokens live for an hour; renew slightly early so a token does
// not expire between the check and the request that uses it.
const ACCESS_TOKEN_EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS = 3600;

export class ZoomCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZoomCredentialError';
  }
}

/**
 * Raised when the signed-in user is not allowed to create apps in their Zoom
 * account. Extends {@link LoginFailedError} so the CLI reports the message on
 * stderr instead of a stack trace.
 */
export class ZoomAppCreationNotPermittedError extends LoginFailedError {
  constructor() {
    super(
      'Your Zoom user is not allowed to create apps in the Zoom App Marketplace: ' +
        'every app type is disabled in the "Build app" dialog. Ask an administrator ' +
        'of your Zoom account to grant you the developer privilege (or to create a ' +
        'Server-to-Server OAuth app and hand you its credentials), then try again. ' +
        'Credentials can also be set manually with ' +
        "'latchkey auth set-nocurl zoom <account-id> <client-id> <client-secret>'."
    );
    this.name = 'ZoomAppCreationNotPermittedError';
  }
}

/**
 * Credentials of a Zoom Server-to-Server OAuth app: the long-lived triple that
 * identifies the app, plus the short-lived access token minted from it.
 */
export const ZoomServerToServerCredentialsSchema = z.object({
  objectType: z.literal('zoomServerToServer'),
  accountId: z.string(),
  clientId: z.string(),
  clientSecret: z.string(),
  accessToken: z.string().optional(),
  accessTokenExpiresAt: z.string().optional(),
});

export type ZoomServerToServerCredentialsData = z.infer<typeof ZoomServerToServerCredentialsSchema>;

export class ZoomServerToServerCredentials implements ApiCredentials {
  readonly objectType = 'zoomServerToServer' as const;
  readonly accountId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly accessToken?: string;
  readonly accessTokenExpiresAt?: string;

  constructor(
    accountId: string,
    clientId: string,
    clientSecret: string,
    accessToken?: string,
    accessTokenExpiresAt?: string
  ) {
    this.accountId = accountId;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.accessToken = accessToken;
    this.accessTokenExpiresAt = accessTokenExpiresAt;
  }

  withAccessToken(
    accessToken: string,
    accessTokenExpiresAt: string
  ): ZoomServerToServerCredentials {
    return new ZoomServerToServerCredentials(
      this.accountId,
      this.clientId,
      this.clientSecret,
      accessToken,
      accessTokenExpiresAt
    );
  }

  injectIntoCurlCall(curlArguments: readonly string[]): Promise<readonly string[]> {
    if (this.accessToken === undefined) {
      throw new ApiCredentialsUsageError(
        'Zoom server-to-server credentials have no access token yet. ' +
          'Run a Zoom request again to have one minted, or re-run the login.'
      );
    }
    return Promise.resolve(['-H', `Authorization: Bearer ${this.accessToken}`, ...curlArguments]);
  }

  /**
   * Missing tokens count as expired: the client id and secret are enough to
   * mint a new one, so refreshing is always the right response.
   */
  isExpired(): boolean {
    if (this.accessToken === undefined || this.accessTokenExpiresAt === undefined) {
      return true;
    }
    const expiresAt = new Date(this.accessTokenExpiresAt).getTime();
    return Date.now() >= expiresAt - ACCESS_TOKEN_EXPIRY_MARGIN_MS;
  }

  toJSON(): ZoomServerToServerCredentialsData {
    return {
      objectType: this.objectType,
      accountId: this.accountId,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      accessToken: this.accessToken,
      accessTokenExpiresAt: this.accessTokenExpiresAt,
    };
  }

  static fromJSON(data: ZoomServerToServerCredentialsData): ZoomServerToServerCredentials {
    return new ZoomServerToServerCredentials(
      data.accountId,
      data.clientId,
      data.clientSecret,
      data.accessToken,
      data.accessTokenExpiresAt
    );
  }
}

/**
 * Exchange the app's client id/secret for an account-level access token.
 * Returns null when Zoom refuses to issue one (for instance while the app is
 * not activated yet).
 */
async function mintAccessToken(
  credentials: ZoomServerToServerCredentials
): Promise<ZoomServerToServerCredentials | null> {
  const body = new URLSearchParams({
    grant_type: 'account_credentials',
    account_id: credentials.accountId,
  });

  const result = await runCapturedAsync(
    [
      '-s',
      '-X',
      'POST',
      '-u',
      `${credentials.clientId}:${credentials.clientSecret}`,
      '-H',
      'Content-Type: application/x-www-form-urlencoded',
      '-d',
      body.toString(),
      ZOOM_TOKEN_ENDPOINT,
    ],
    30
  );
  if (result.returncode !== 0) {
    return null;
  }

  const response = tryParseJson(result.stdout) as {
    access_token?: string;
    expires_in?: number;
  } | null;
  if (response?.access_token === undefined) {
    return null;
  }

  const lifetimeSeconds = response.expires_in ?? DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS;
  return credentials.withAccessToken(
    response.access_token,
    new Date(Date.now() + lifetimeSeconds * 1000).toISOString()
  );
}

// --- Browser automation ------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 8000;

// The app pages are a single-page app: steps change the URL without a document
// load, so progress is observed by polling rather than by navigation events.
const URL_POLL_INTERVAL_MS = 200;
const APP_CREATION_TIMEOUT_MS = 30_000;

// Time given to a dialog or page to render after a click.
const PAGE_SETTLE_MS = 1000;

// The "Build app" dialog may be preceded by the API terms of use, which reload
// the page when accepted, so the click may have to be repeated.
const BUILD_APP_ATTEMPTS = 4;

// Zoom walks the app setup through several pages (credentials, information,
// feature, scopes), each behind its own "Continue" button, and rejects
// incomplete pages by staying put.
const MAX_CONTINUE_CLICKS = 8;

// A freshly activated app takes a moment to become usable for token minting.
const TOKEN_MINTING_ATTEMPTS = 5;
const TOKEN_MINTING_RETRY_DELAY_MS = 2000;

// Marketplace pages expose the signed-in user, their privileges and their
// account in a global object, which is both more reliable and more
// language-independent than reading the rendered page.
const ZoomMarketplaceUserInfoSchema = z.object({
  email: z.string().optional(),
  userName: z.string().optional(),
  canBuildServerToServerOAuthApp: z.boolean().optional(),
});

type ZoomMarketplaceUserInfo = z.infer<typeof ZoomMarketplaceUserInfoSchema>;

// Marker of a Marketplace page rendered for a signed-in user.
const SIGNED_IN_MARKETPLACE_PAGE_PATTERN = /window\.appConf\.userInfo = \{[^\n]*"email":"[^"]+"/;

const APP_CREDENTIALS_URL_PATTERN = /\/develop\/apps\/([^/?#]+)\/credentials/;

// The app kind ("General app", "Server to Server OAuth app", ...) is chosen in a
// dialog of radio buttons whose only distinguishing feature is their label.
const SERVER_TO_SERVER_APP_KIND_PATTERN = /server\s*to\s*server/i;
const BUILD_APP_MENU_ITEM_PATTERN = /build\s*app/i;
const ADD_SCOPES_BUTTON_PATTERN = /add\s*scopes?/i;
const SELECT_ALL_SCOPES_PATTERN = /^select all/i;
const SELECT_ALL_ADMIN_SCOPES_PATTERN = /\(admin\)/i;

// The dialogs of the two design systems Zoom's Marketplace mixes mark their
// confirming button ("Create", "Done") as the primary one, which avoids having
// to match its label.
const ENABLED_PRIMARY_DIALOG_BUTTON_SELECTOR =
  '[role="dialog"]:visible button:is(.MuiButton-primary, .ui-Button-primary)' +
  ':not([disabled]):not([aria-disabled="true"])';

// The API terms dialog is recognized by its link to the license document, which
// does not depend on the interface language.
const API_TERMS_DIALOG_SELECTOR =
  '[role="dialog"]:visible:has(a[href*="zoom_api_license_and_tou"])';

// Labels of the fields the app information page requires, most likely first.
// Zoom has renamed them across versions of the page, and which ones are shown
// depends on the app, so every candidate is tried and missing ones are skipped.
const COMPANY_NAME_LABELS = ['Company Name', 'Company'] as const;
const DEVELOPER_NAME_LABELS = ['Developer Name', 'Name'] as const;
const DEVELOPER_EMAIL_LABELS = ['Developer Email', 'Email Address', 'Email'] as const;

function visibleDialog(page: Page): Locator {
  // The Marketplace keeps dialogs of pages already visited in the DOM, so the
  // one to act on is the last visible one.
  return page.locator('[role="dialog"]:visible').last();
}

async function readMarketplaceUserInfo(page: Page): Promise<ZoomMarketplaceUserInfo> {
  const rawUserInfo: unknown = await page.evaluate(() => {
    const appConf = (globalThis as { appConf?: { userInfo?: unknown } }).appConf;
    return appConf?.userInfo ?? null;
  });
  const parsed = ZoomMarketplaceUserInfoSchema.safeParse(rawUserInfo);
  return parsed.success ? parsed.data : {};
}

async function clickEnabledPrimaryDialogButton(page: Page): Promise<void> {
  const button = page.locator(ENABLED_PRIMARY_DIALOG_BUTTON_SELECTOR).last();
  await button.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await button.click();
}

/**
 * Accept Zoom's API License and Terms of Use, which are shown once per account
 * before the first app can be created. Reports whether the dialog was there.
 */
async function acceptApiTermsOfUseIfPresent(page: Page): Promise<boolean> {
  const dialog = page.locator(API_TERMS_DIALOG_SELECTOR);
  if ((await dialog.count()) === 0) {
    return false;
  }
  // The dialog has no primary-button class, but its actions are ordered with
  // the accepting button ("Agree") first.
  const agreeButton = dialog.locator('.MuiDialogActions-root button').first();
  await agreeButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await agreeButton.click();
  await page.waitForTimeout(PAGE_SETTLE_MS);
  return true;
}

async function clickDevelopBuildApp(page: Page): Promise<void> {
  const developMenuButton = page.locator('button[data-ta="develop"]');
  await developMenuButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await developMenuButton.click();

  const buildAppMenuItem = page
    .getByRole('menuitem', { name: BUILD_APP_MENU_ITEM_PATTERN })
    .first();
  await buildAppMenuItem.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await buildAppMenuItem.click();
}

/**
 * Open the dialog that asks what kind of app to create, accepting the API terms
 * of use on the way if the account has not signed them yet.
 */
async function openAppKindDialog(page: Page): Promise<Locator> {
  const appKindDialog = page
    .locator('[role="dialog"]:visible')
    .filter({ has: page.locator('input[type="radio"]') })
    .last();

  for (let attempt = 0; attempt < BUILD_APP_ATTEMPTS; attempt++) {
    await acceptApiTermsOfUseIfPresent(page);
    if (await appKindDialog.isVisible()) {
      return appKindDialog;
    }
    await clickDevelopBuildApp(page);
    await page.waitForTimeout(PAGE_SETTLE_MS);
  }

  throw new LoginFailedError(
    'Zoom\'s "Build app" dialog did not open; the App Marketplace may have changed.'
  );
}

async function selectServerToServerAppKind(appKindDialog: Locator): Promise<void> {
  if ((await appKindDialog.locator('input[type="radio"]:not([disabled])').count()) === 0) {
    throw new ZoomAppCreationNotPermittedError();
  }

  const serverToServerOption = appKindDialog
    .locator('label')
    .filter({ hasText: SERVER_TO_SERVER_APP_KIND_PATTERN })
    .locator('input[type="radio"]')
    .first();
  if ((await serverToServerOption.count()) === 0) {
    throw new LoginFailedError(
      'Zoom does not offer the "Server to Server OAuth" app type to your user. ' +
        'Ask an administrator of your Zoom account to enable it for you.'
    );
  }
  if (!(await serverToServerOption.isEnabled())) {
    throw new ZoomAppCreationNotPermittedError();
  }
  await serverToServerOption.check();
}

async function nameAndCreateApp(page: Page, appName: string): Promise<void> {
  const appNameInput = page.locator('input[data-ta="app-name"]');
  await appNameInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await typeLikeHuman(page, appNameInput, appName);
  await clickEnabledPrimaryDialogButton(page);
}

/**
 * Wait until Zoom opens the credentials page of the new app and return the app
 * id taken from its URL.
 */
async function waitForCreatedAppId(page: Page): Promise<string> {
  const deadline = Date.now() + APP_CREATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const appId = APP_CREDENTIALS_URL_PATTERN.exec(page.url())?.[1];
    if (appId !== undefined) {
      return appId;
    }
    await page.waitForTimeout(URL_POLL_INTERVAL_MS);
  }
  throw new LoginFailedError(
    `Zoom did not open the credentials page of the new app (last URL: ${page.url()}).`
  );
}

async function readCredentialField(page: Page, fieldName: string): Promise<string> {
  const input = page.locator(`input[name="${fieldName}"]`);
  await input.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  const value = await input.inputValue();
  if (value === '') {
    throw new LoginFailedError(`Zoom left the app credential field '${fieldName}' empty.`);
  }
  return value;
}

async function readAppCredentials(page: Page): Promise<ZoomServerToServerCredentials> {
  return new ZoomServerToServerCredentials(
    await readCredentialField(page, 'devAccountId'),
    await readCredentialField(page, 'devClientId'),
    await readCredentialField(page, 'devClientSecret')
  );
}

/**
 * Locate the input belonging to a label, in both the current form layout (which
 * pairs a label box with the input inside a shared group) and the older one
 * (which uses a plain `<label for=...>`). Returns null when the page has no
 * such field.
 */
async function findLabeledInput(page: Page, labelText: string): Promise<Locator | null> {
  const groupedInput = page
    .locator(`div[type="layout"]:has(div[variant="label"]:text-is("${labelText}")) input`)
    .first();
  if ((await groupedInput.count()) > 0) {
    return groupedInput;
  }
  const labelledInput = page.getByLabel(labelText, { exact: true }).first();
  return (await labelledInput.count()) > 0 ? labelledInput : null;
}

/**
 * Fill the first of the candidate fields that the page actually has, leaving
 * fields that already carry a value alone.
 */
async function fillLabeledInput(
  page: Page,
  labelCandidates: readonly string[],
  value: string
): Promise<void> {
  for (const labelText of labelCandidates) {
    const input = await findLabeledInput(page, labelText);
    if (input === null) {
      continue;
    }
    if ((await input.inputValue()) === '') {
      await typeLikeHuman(page, input, value);
    }
    return;
  }
}

/**
 * Fill the developer contact details Zoom requires before an app can go live,
 * using the signed-in user's own name and e-mail address. The company is taken
 * from the e-mail domain, the only company-like information the Marketplace
 * exposes about the account.
 */
async function fillDeveloperInformation(
  page: Page,
  userInfo: ZoomMarketplaceUserInfo
): Promise<void> {
  if (userInfo.userName !== undefined) {
    await fillLabeledInput(page, DEVELOPER_NAME_LABELS, userInfo.userName);
  }
  if (userInfo.email !== undefined) {
    await fillLabeledInput(page, DEVELOPER_EMAIL_LABELS, userInfo.email);
    const emailDomain = userInfo.email.split('@')[1];
    if (emailDomain !== undefined) {
      await fillLabeledInput(page, COMPANY_NAME_LABELS, emailDomain);
    }
  }
}

async function clickContinueButton(page: Page): Promise<void> {
  const continueButton = page.locator('button[data-ta="continue-button"]');
  await continueButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await continueButton.click();
}

/**
 * Walk the app setup pages from the credentials page to the scopes page,
 * filling in the developer information Zoom asks for along the way. Zoom
 * refuses to move on from an incomplete page, so each step retries until the
 * scopes page is reached.
 */
async function continueToScopesPage(
  page: Page,
  appId: string,
  userInfo: ZoomMarketplaceUserInfo
): Promise<void> {
  const scopesPath = `/develop/apps/${appId}/scope`;
  for (let attempt = 0; attempt < MAX_CONTINUE_CLICKS; attempt++) {
    if (new URL(page.url()).pathname === scopesPath) {
      return;
    }
    await fillDeveloperInformation(page, userInfo);
    await clickContinueButton(page);
    await page.waitForTimeout(PAGE_SETTLE_MS);
  }
  throw new LoginFailedError(
    `Zoom's app setup did not reach the scopes page (stuck at ${page.url()}). ` +
      'Complete the app setup in the browser window to finish the login.'
  );
}

/**
 * Grant the app every admin scope its account offers, so a single set of
 * credentials can serve any Zoom API call the account is entitled to.
 */
async function addAllAdminScopes(page: Page): Promise<void> {
  const addScopesButton = page.getByRole('button', { name: ADD_SCOPES_BUTTON_PATTERN }).first();
  await addScopesButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await addScopesButton.click();

  const scopesDialog = visibleDialog(page);
  const selectAllMenu = scopesDialog.getByText(SELECT_ALL_SCOPES_PATTERN).first();
  await selectAllMenu.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await selectAllMenu.click();

  // The menu opens outside the dialog, so it is looked up on the page.
  const selectAllAdminItem = page
    .getByRole('menuitem', { name: SELECT_ALL_ADMIN_SCOPES_PATTERN })
    .first();
  await selectAllAdminItem.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await selectAllAdminItem.click();

  // Confirm the selection ("Done").
  await clickEnabledPrimaryDialogButton(page);
  await page.waitForTimeout(PAGE_SETTLE_MS);
}

async function activateApp(page: Page): Promise<void> {
  const activateButton = page.locator('button[data-ta="activeAppBtn"]');
  await activateButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  await activateButton.click();
  await page.waitForTimeout(PAGE_SETTLE_MS);

  // Some accounts have to confirm the activation in a dialog.
  if ((await page.locator(ENABLED_PRIMARY_DIALOG_BUTTON_SELECTOR).count()) > 0) {
    await clickEnabledPrimaryDialogButton(page);
    await page.waitForTimeout(PAGE_SETTLE_MS);
  }
}

/**
 * Mint the first access token of the new app, retrying because activation takes
 * a moment to take effect.
 */
async function mintFirstAccessToken(
  page: Page,
  credentials: ZoomServerToServerCredentials
): Promise<ZoomServerToServerCredentials> {
  for (let attempt = 0; attempt < TOKEN_MINTING_ATTEMPTS; attempt++) {
    const withToken = await mintAccessToken(credentials);
    if (withToken !== null) {
      return withToken;
    }
    await page.waitForTimeout(TOKEN_MINTING_RETRY_DELAY_MS);
  }
  throw new LoginFailedError(
    'Zoom did not issue an access token for the new app. Check in the browser ' +
      'window whether the app was activated, and try again.'
  );
}

class ZoomServiceSession extends BrowserFollowupServiceSession {
  protected readonly followupWork = FollowupWork.CreateApp;
  private isSignedIn = false;

  onResponse(response: Response): void {
    if (this.isSignedIn) {
      return;
    }
    if (!response.request().url().startsWith('https://marketplace.zoom.us/')) {
      return;
    }
    if (response.status() !== 200) {
      return;
    }
    void response
      .text()
      .then((body) => {
        if (SIGNED_IN_MARKETPLACE_PAGE_PATTERN.test(body)) {
          this.isSignedIn = true;
        }
      })
      .catch(() => {
        // Bodies that can no longer be read prove nothing either way.
      });
  }

  protected isLoginComplete(): boolean {
    return this.isSignedIn;
  }

  protected async performBrowserFollowup(
    context: BrowserContext,
    _oldCredentials?: ApiCredentials
  ): Promise<ApiCredentials | null> {
    const page = context.pages()[0];
    if (!page) {
      throw new LoginFailedError('No page available in browser context.');
    }

    await page.goto(ZOOM_MARKETPLACE_BUILD_URL);

    const userInfo = await readMarketplaceUserInfo(page);
    if (userInfo.canBuildServerToServerOAuthApp === false) {
      throw new ZoomAppCreationNotPermittedError();
    }

    const appKindDialog = await openAppKindDialog(page);
    await selectServerToServerAppKind(appKindDialog);
    await clickEnabledPrimaryDialogButton(page);

    await nameAndCreateApp(page, this.generateAppName());

    const appId = await waitForCreatedAppId(page);
    const credentials = await readAppCredentials(page);

    await continueToScopesPage(page, appId, userInfo);
    await addAllAdminScopes(page);
    await clickContinueButton(page);
    await activateApp(page);

    const credentialsWithToken = await mintFirstAccessToken(page, credentials);
    await page.close();
    return credentialsWithToken;
  }
}

export class Zoom extends Service {
  readonly name = 'zoom';
  readonly displayName = 'Zoom';
  readonly baseApiUrls = ['https://api.zoom.us/v2/'] as const;
  readonly loginUrl = ZOOM_MARKETPLACE_BUILD_URL;
  readonly info =
    'https://developers.zoom.us/docs/api/. ' +
    'Browser login creates a Server-to-Server OAuth app with all admin scopes; ' +
    'its access token is renewed automatically.';

  readonly credentialCheckCurlArguments = [
    '-H',
    'Content-Type: application/json',
    'https://api.zoom.us/v2/users?page_size=1',
  ] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set-nocurl ${serviceName} <account-id> <client-id> <client-secret>`;
  }

  /**
   * Accept the credentials of a Server-to-Server OAuth app the user created
   * themselves, in the order the Zoom App Marketplace shows them.
   */
  override getCredentialsNoCurl(arguments_: readonly string[]): ApiCredentials {
    const [accountId, clientId, clientSecret] = arguments_;
    if (
      arguments_.length !== 3 ||
      accountId === undefined ||
      clientId === undefined ||
      clientSecret === undefined
    ) {
      throw new ZoomCredentialError(
        'Expected exactly three arguments: <account-id> <client-id> <client-secret>.\n' +
          'They are the credentials of a Zoom Server-to-Server OAuth app.\n' +
          `Example: ${this.setCredentialsExample(this.name)}`
      );
    }
    return new ZoomServerToServerCredentials(accountId, clientId, clientSecret);
  }

  override getSession(appNamePrefix: string): ZoomServiceSession {
    return new ZoomServiceSession(this, appNamePrefix);
  }

  /**
   * The account comes from /users/me rather than the user-list endpoint used
   * by the credential check, which carries no identity. Server-to-server
   * tokens have no user context and error on /users/me, in which case the
   * app's Zoom account id identifies the account instead.
   */
  override async getAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    const account = await fetchAccountFromEndpoint(
      apiCredentials,
      ['https://api.zoom.us/v2/users/me'],
      (responseBody) => {
        const data = tryParseJson(responseBody) as {
          email?: string;
          id?: string;
          code?: number;
        } | null;
        if (data === null || data.code !== undefined) {
          return null;
        }
        return data.email ?? data.id ?? null;
      }
    );
    if (account !== null) {
      return account;
    }
    return apiCredentials instanceof ZoomServerToServerCredentials
      ? apiCredentials.accountId
      : null;
  }

  /**
   * Server-to-server credentials carry no refresh token: a fresh access token
   * is minted from the client id and secret whenever the old one expires.
   */
  override async refreshCredentials(
    apiCredentials: ApiCredentials
  ): Promise<ApiCredentials | null> {
    if (!(apiCredentials instanceof ZoomServerToServerCredentials)) {
      return null;
    }
    return await mintAccessToken(apiCredentials);
  }
}

export const ZOOM = new Zoom();
