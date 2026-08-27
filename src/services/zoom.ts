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
  isBrowserClosedError,
  LoginCancelledError,
  LoginFailedError,
  Service,
  type ManualCredentialForm,
} from './core/base.js';

const ZOOM_TOKEN_ENDPOINT = 'https://zoom.us/oauth/token';

// Sign-in happens on Zoom itself rather than on the App Marketplace, which
// bounces visitors through a less predictable chain of pages.
const ZOOM_SIGN_IN_URL = 'https://zoom.us/signin#/login';

// Where Zoom lands a user once signed in: their home page or their profile,
// depending on the account, served by whichever regional host runs it
// (https://us06web.zoom.us/profile, ...) and possibly with a query or a subpath
// behind it. The redirect there names the page either as an absolute URL or as
// a path.
const SIGNED_IN_LANDING_URL_PATTERN = /^(https:\/\/([\w-]+\.)*zoom\.us)?\/(myhome|profile)\b/i;

/**
 * Whether a URL names a page Zoom lands a user on once they are signed in. Also
 * accepts the bare path, the form a redirect to it may take.
 */
export function isZoomSignedInLandingUrl(url: string): boolean {
  return SIGNED_IN_LANDING_URL_PATTERN.test(url);
}

// The Marketplace page that lists the user's apps and carries the sidebar menu
// the app creation flow starts from.
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
      'Your Zoom user is not allowed to create apps in the Zoom App Marketplace. Ask an administrator ' +
        'of your Zoom account to grant you the developer privilege, then try again.'
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
  readonly accountEmail?: string;

  constructor(
    accountId: string,
    clientId: string,
    clientSecret: string,
    accessToken?: string,
    accessTokenExpiresAt?: string,
    accountEmail?: string
  ) {
    this.accountId = accountId;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.accessToken = accessToken;
    this.accessTokenExpiresAt = accessTokenExpiresAt;
    this.accountEmail = accountEmail;
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
      accessTokenExpiresAt,
      this.accountEmail
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

// Time given to a dialog or menu to finish animating into place.
const ANIMATION_SETTLE_MS = 300;

// The "Build app" dialog may be preceded by the API terms of use, which the
// user has to accept before Zoom lets the flow continue, so the click may have
// to be repeated.
const BUILD_APP_ATTEMPTS = 4;

// Time allowed for the user to accept Zoom's API License and Terms of Use.
const TERMS_OF_USE_USER_INTERACTION_TIMEOUT_MS = 10 * 60 * 1000;

// Zoom walks the app setup through several pages (credentials, information,
// feature, scopes), each behind its own "Continue" button, and rejects
// incomplete pages by staying put.
const MAX_CONTINUE_CLICKS = 8;

// A freshly activated app takes a moment to become usable for token minting.
const TOKEN_MINTING_ATTEMPTS = 5;
const TOKEN_MINTING_RETRY_DELAY_MS = 2000;

// Marketplace pages expose the signed-in user, their privileges and their
// account in a global object, which is both more reliable and more
// language-independent than reading the rendered page. Zoom names the privilege
// to create a server-to-server app twice, once after the app type as the
// Marketplace shows it and once after the OAuth flow behind it; the app creation
// dialog goes by the latter.
const ZoomMarketplaceUserInfoSchema = z.object({
  email: z.string().optional(),
  userName: z.string().optional(),
  canBuildServerToServerOAuthApp: z.boolean().optional(),
  canBuildTwoLeggedOAuthApp: z.boolean().optional(),
});

type ZoomMarketplaceUserInfo = z.infer<typeof ZoomMarketplaceUserInfoSchema>;

const APP_CREDENTIALS_URL_PATTERN = /\/develop\/apps\/([^/?#]+)\/credentials/;

// The two controls that carry nothing but their label: the app kind radio
// buttons all have an empty value, and the "Build app" menu item has neither an
// id nor a test attribute. Everything else is addressed through `data-ta`
// attributes, input names, icons or structural classes, none of which depend on
// the interface language.
const SERVER_TO_SERVER_APP_KIND_PATTERN = /server\s*to\s*server/i;
const BUILD_APP_MENU_ITEM_PATTERN = /build\s*app/i;

// The "Add Scopes" button and the "Select All" menu of the scope dialog have no
// attributes to go by either, but they are the only elements on their page drawn
// with a plus icon respectively a drop-down triangle.
const ADD_SCOPES_BUTTON_SELECTOR = 'button:has(svg mask[id^="icon_PlusSmallOutline"])';
const SELECT_ALL_SCOPES_GLYPH = '\u25be';

// The dialogs of the two design systems Zoom's Marketplace mixes mark their
// confirming button ("Create", "Done") as the primary one, which avoids having
// to match its label.
const ENABLED_PRIMARY_BUTTON_SELECTOR =
  'button:is(.MuiButton-primary, .ui-Button-primary):not([disabled]):not([aria-disabled="true"])';
const ENABLED_PRIMARY_DIALOG_BUTTON_SELECTOR = `[role="dialog"]:visible ${ENABLED_PRIMARY_BUTTON_SELECTOR}`;

// The scope dialog counts the selection next to the button that confirms it;
// only the number is read, so the wording does not matter.
const SELECTED_SCOPE_COUNT_PATTERN = /\d+/;

// How long to give the dialog to work a group's scopes into the selection.
const SCOPE_SELECTION_TIMEOUT_MS = 5000;

// The scope dialog groups the scopes by product, one tab each, and its "Select
// All" only ever reaches the group on display — so every group worth having is
// visited in turn. The tabs are named after Zoom's products, which is all there
// is to tell them apart; anchoring the names keeps "Contacts" from picking
// "Contact Center". Groups an account does not have are simply absent.
const SCOPE_GROUP_PATTERNS = [
  /^Team Chat$/i,
  /^Meetings$/i,
  /^Recording$/i,
  /^User$/i,
  /^Calendar$/i,
  /^ZOOM$/i,
  /^Dashboard$/i,
  /^Contacts$/i,
  /^Message$/i,
] as const;

// The app creation menu hangs off the plus button in the "Developer" section of
// the Marketplace sidebar. Its label is written into Zoom's code rather than
// translated, so it does not depend on the interface language.
const BUILD_MENU_BUTTON_SELECTOR = 'button[aria-label="Add"][aria-haspopup="true"]';

// The Marketplace is a heavy single-page app whose sidebar only shows up once it
// has hydrated, which takes noticeably longer than any step that follows.
const MARKETPLACE_LOAD_TIMEOUT_MS = 30_000;

// The API terms dialog is recognized by its link to the license document, which
// does not depend on the interface language. The app kind dialog is the one
// asking to pick between radio buttons.
const API_TERMS_DIALOG_SELECTOR =
  '[role="dialog"]:visible:has(a[href*="zoom_api_license_and_tou"])';
const APP_KIND_DIALOG_SELECTOR = '[role="dialog"]:visible:has(input[type="radio"])';

// The inputs of the app information page are named after the fields of Zoom's
// app model (as are those of the credentials page). Matching the name as a
// substring absorbs the spellings Zoom uses for the developer contact across
// versions of the page, and covers pages that ask for a second contact.
const COMPANY_NAME_INPUT_SELECTOR = 'input[name*="company" i]';
const DEVELOPER_NAME_INPUT_SELECTOR =
  'input[name*="developername" i], input[name*="contactname" i], input[name*="supportname" i]';
const DEVELOPER_EMAIL_INPUT_SELECTOR = 'input[name*="email" i]';

function visibleDialog(page: Page): Locator {
  // The Marketplace keeps dialogs of pages already visited in the DOM, so the
  // one to act on is the last visible one.
  return page.locator('[role="dialog"]:visible').last();
}

/**
 * Wait for the Marketplace sidebar to be there and settle: it hydrates after the
 * page load and re-renders shortly after. Clicking into it before that opens a
 * menu the re-render then closes again.
 */
async function waitForMarketplaceSidebar(page: Page): Promise<void> {
  await page.locator(BUILD_MENU_BUTTON_SELECTOR).waitFor({ timeout: MARKETPLACE_LOAD_TIMEOUT_MS });
  await page.waitForTimeout(PAGE_SETTLE_MS);
}

/**
 * Read the signed-in user, their privileges and their account off a Marketplace
 * page. Returns null when the page carries no user, which is how a Marketplace
 * page rendered for a visitor who is not (or no longer) signed in looks.
 */
async function readMarketplaceUserInfo(page: Page): Promise<ZoomMarketplaceUserInfo | null> {
  const rawUserInfo: unknown = await page.evaluate(() => {
    const appConf = (globalThis as { appConf?: { userInfo?: unknown } }).appConf;
    return appConf?.userInfo ?? null;
  });
  const parsed = ZoomMarketplaceUserInfoSchema.safeParse(rawUserInfo);
  if (!parsed.success) {
    return null;
  }
  const userInfo = parsed.data;
  return userInfo.email === undefined && userInfo.userName === undefined ? null : userInfo;
}

async function clickEnabledPrimaryDialogButton(page: Page): Promise<void> {
  await clickControl(page.locator(ENABLED_PRIMARY_DIALOG_BUTTON_SELECTOR).last());
}

/**
 * Click a control of the Marketplace's interface.
 *
 * Its buttons and menu entries swap modal layers in and out, and a backdrop
 * appearing while the mouse button is still down is what Playwright reads as
 * its own click having been intercepted: it discards the click and retries —
 * only now the backdrop that the first click brought up blocks every attempt,
 * until the action times out with a menu or dialog sitting open. Forcing the
 * click sends the same mouse events without that hit-target check, which is
 * why every click of this flow goes through here.
 */
async function clickControl(locator: Locator): Promise<void> {
  await locator.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  // A forced click skips the wait for the element to stop moving, so a dialog
  // or menu still animating into place gets its time here instead.
  await locator.page().waitForTimeout(ANIMATION_SETTLE_MS);
  await locator.click({ force: true });
}

/**
 * Ask for the app creation dialog through the sidebar's "Build app" menu.
 *
 * The plus button toggles the menu, so an attempt that left it open carries on
 * with it rather than clicking it away again; the button says which of the two
 * it is through aria-expanded. The menu itself is a plain popup rather than a
 * modal one, so its entry takes an ordinary click.
 */
async function chooseBuildApp(page: Page): Promise<void> {
  const buildMenuButton = page.locator(BUILD_MENU_BUTTON_SELECTOR).first();
  await buildMenuButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
  if ((await buildMenuButton.getAttribute('aria-expanded')) !== 'true') {
    await clickControl(buildMenuButton);
  }

  await clickControl(page.getByRole('menuitem', { name: BUILD_APP_MENU_ITEM_PATTERN }).first());
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

  // The radio button reports the choice but does not make it: the click is
  // handled by the card around it, which is why the choice is made with a click
  // like every other one of this flow rather than with Playwright's check().
  await clickControl(serverToServerOption);
  await serverToServerOption.page().waitForTimeout(ANIMATION_SETTLE_MS);
  if (!(await serverToServerOption.isChecked())) {
    throw new LoginFailedError(
      'Zoom did not take "Server to Server OAuth" as the kind of app to create. ' +
        'Create the app in the browser window to finish the login.'
    );
  }
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

async function readAppCredentials(
  page: Page,
  accountEmail?: string
): Promise<ZoomServerToServerCredentials> {
  return new ZoomServerToServerCredentials(
    await readCredentialField(page, 'devAccountId'),
    await readCredentialField(page, 'devClientId'),
    await readCredentialField(page, 'devClientSecret'),
    undefined,
    undefined,
    accountEmail
  );
}

/**
 * Type the value into every input the selector matches that is still empty and
 * open for editing, so fields Zoom prefilled (or the user filled) are left as
 * they are. Matching nothing is fine: which fields a page asks for varies.
 */
async function fillEmptyInputs(page: Page, selector: string, value: string): Promise<void> {
  for (const input of await page.locator(selector).all()) {
    if (!(await input.isVisible()) || !(await input.isEditable())) {
      continue;
    }
    if ((await input.inputValue()) !== '') {
      continue;
    }
    await typeLikeHuman(page, input, value);
  }
}

/**
 * Fill the developer contact details Zoom requires before an app can go live:
 * the signed-in user's own name and e-mail address, and as the company the name
 * the app is created under, which says where the app came from.
 */
async function fillDeveloperInformation(
  page: Page,
  userInfo: ZoomMarketplaceUserInfo,
  companyName: string
): Promise<void> {
  await fillEmptyInputs(page, COMPANY_NAME_INPUT_SELECTOR, companyName);
  if (userInfo.userName !== undefined) {
    await fillEmptyInputs(page, DEVELOPER_NAME_INPUT_SELECTOR, userInfo.userName);
  }
  if (userInfo.email !== undefined) {
    await fillEmptyInputs(page, DEVELOPER_EMAIL_INPUT_SELECTOR, userInfo.email);
  }
}

async function clickContinueButton(page: Page): Promise<void> {
  await clickControl(page.locator('button[data-ta="continue-button"]'));
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
  userInfo: ZoomMarketplaceUserInfo,
  companyName: string
): Promise<void> {
  const scopesPath = `/develop/apps/${appId}/scope`;
  for (let attempt = 0; attempt < MAX_CONTINUE_CLICKS; attempt++) {
    if (new URL(page.url()).pathname === scopesPath) {
      return;
    }
    await fillDeveloperInformation(page, userInfo, companyName);
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
/**
 * How many scopes the dialog reports as selected, or null when it shows no
 * count at all.
 */
async function readSelectedScopeCount(scopesDialog: Locator): Promise<number | null> {
  // The count sits beside the confirming button, in the footer of the dialog.
  const footer = scopesDialog.locator(ENABLED_PRIMARY_BUTTON_SELECTOR).last().locator('xpath=..');
  const countMatch = SELECTED_SCOPE_COUNT_PATTERN.exec((await footer.textContent()) ?? '');
  return countMatch === null ? null : Number(countMatch[0]);
}

/**
 * Wait for the dialog's count of selected scopes to move on from what it was,
 * which working a group into the selection takes it a moment to do. A group
 * that holds no scopes for this account never moves it, so running out of time
 * is not an error.
 */
async function waitForSelectedScopeCountChange(
  page: Page,
  scopesDialog: Locator,
  previousCount: number | null
): Promise<void> {
  const deadline = Date.now() + SCOPE_SELECTION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await readSelectedScopeCount(scopesDialog)) !== previousCount) {
      return;
    }
    await page.waitForTimeout(URL_POLL_INTERVAL_MS);
  }
}

/**
 * Add every scope of the group on display to the selection. The entries of the
 * "Select All" menu widen from account level outwards ("Select All (Admin)",
 * then "(Master)", then "(All)"), so the account-level one is the first.
 */
async function selectAllScopesOfGroup(page: Page, scopesDialog: Locator): Promise<void> {
  const previousCount = await readSelectedScopeCount(scopesDialog);

  await clickControl(scopesDialog.getByText(SELECT_ALL_SCOPES_GLYPH).first());
  // The menu opens outside the dialog, so it is looked up on the page.
  await clickControl(
    page.locator('[role="menu"]:visible').last().locator('[role="menuitem"]').first()
  );

  await waitForSelectedScopeCountChange(page, scopesDialog, previousCount);
}

/**
 * Grant the app the scopes of every product group worth having, so a single set
 * of credentials can serve the Zoom APIs an account is entitled to.
 *
 * Confirming a selection that stayed empty would leave the app created,
 * activated and unable to call a single API, so that is refused outright.
 */
async function addAllScopes(page: Page): Promise<void> {
  await clickControl(page.locator(ADD_SCOPES_BUTTON_SELECTOR).first());
  const scopesDialog = visibleDialog(page);

  for (const groupPattern of SCOPE_GROUP_PATTERNS) {
    const groupTab = scopesDialog.getByRole('tab', { name: groupPattern }).first();
    if ((await groupTab.count()) === 0) {
      continue;
    }
    await clickControl(groupTab);
    await selectAllScopesOfGroup(page, scopesDialog);
  }

  const selectedCount = await readSelectedScopeCount(scopesDialog);
  if (selectedCount === 0) {
    throw new LoginFailedError(
      'Zoom selected no scopes for the app, which would leave it unable to call ' +
        'any API. Add the scopes in the browser window, or ask an administrator of ' +
        'your Zoom account for the privileges to do so.'
    );
  }

  // Confirm the selection ("Done").
  await clickEnabledPrimaryDialogButton(page);
  await page.waitForTimeout(PAGE_SETTLE_MS);
}

async function activateApp(page: Page): Promise<void> {
  await clickControl(page.locator('button[data-ta="activeAppBtn"]'));
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
  override readonly manualCredentialForm: ManualCredentialForm = {
    instructions:
      `To finish by hand, open ${ZOOM_MARKETPLACE_BUILD_URL} in the other tab of this ` +
      'window and create (or open) a "Server-to-Server OAuth" app, adding the appropriate scopes ' +
      "and activating it. Its three credentials are on the app's " +
      '"App Credentials" page.',
    fields: [
      { name: 'accountId', label: 'Account ID' },
      { name: 'clientId', label: 'Client ID' },
      { name: 'clientSecret', label: 'Client secret' },
    ],
    buildCredentials: (values) =>
      new ZoomServerToServerCredentials(
        values.get('accountId'),
        values.get('clientId'),
        values.get('clientSecret')
      ),
  };
  private isSignedIn = false;

  /**
   * Sign-in is over once Zoom sends the user on to their home page or profile,
   * which it does after the last step of the sign-in (whatever two-factor or
   * consent steps came before). Being sent there is enough — waiting for that
   * page to answer, let alone to render, would only cost a round trip, since
   * the flow navigates away from it to the Marketplace anyway.
   */
  onResponse(response: Response): void {
    if (this.isSignedIn) {
      return;
    }
    if (!response.request().isNavigationRequest()) {
      return;
    }
    const redirectTarget = response.headers().location;
    if (
      isZoomSignedInLandingUrl(response.request().url()) ||
      (redirectTarget !== undefined && isZoomSignedInLandingUrl(redirectTarget))
    ) {
      this.isSignedIn = true;
    }
  }

  protected isLoginComplete(): boolean {
    return this.isSignedIn;
  }

  /**
   * Accounts that have not accepted Zoom's API License and Terms of Use yet see
   * a dialog blocking the app creation. Accepting the terms is the user's
   * decision, so the page is surfaced and the flow waits until the dialog is
   * gone rather than clicking "Agree" on the user's behalf.
   */
  private async waitForApiTermsOfUseDecision(page: Page): Promise<void> {
    const termsDialog = page.locator(API_TERMS_DIALOG_SELECTOR).first();
    if ((await termsDialog.count()) === 0) {
      return;
    }

    try {
      await page.bringToFront();
      // Either button of the dialog closes it: declining leaves the terms
      // unsigned, which shows the dialog again on the next attempt.
      await termsDialog.waitFor({
        state: 'hidden',
        timeout: TERMS_OF_USE_USER_INTERACTION_TIMEOUT_MS,
      });
    } catch (error: unknown) {
      if (error instanceof Error && isBrowserClosedError(error)) {
        throw new LoginCancelledError();
      }
      throw error;
    }

    await this.spinnerPage?.bringToFront();
    await page.waitForTimeout(PAGE_SETTLE_MS);
  }

  /**
   * Open the dialog that asks what kind of app to create, letting the user
   * accept the API terms of use on the way if the account has not signed them
   * yet.
   */
  private async openAppKindDialog(page: Page): Promise<Locator> {
    const appKindDialog = page.locator(APP_KIND_DIALOG_SELECTOR).last();

    for (let attempt = 0; attempt < BUILD_APP_ATTEMPTS; attempt++) {
      await this.waitForApiTermsOfUseDecision(page);
      if (await appKindDialog.isVisible()) {
        return appKindDialog;
      }
      await chooseBuildApp(page);
      // Zoom fetches the dialog rather than having it ready, so wait for
      // whichever it puts up: the app kinds, or the terms of use that have to
      // be accepted first.
      await page
        .locator(`${APP_KIND_DIALOG_SELECTOR}, ${API_TERMS_DIALOG_SELECTOR}`)
        .first()
        .waitFor({ timeout: DEFAULT_TIMEOUT_MS })
        .catch(() => {
          // Neither showed up; the next attempt asks for the dialog again.
        });
    }

    throw new LoginFailedError(
      'Zoom\'s "Build app" dialog did not open. Zoom asks for its API License ' +
        'and Terms of Use to be accepted before an app can be created; without ' +
        'that, the app has to be created manually.'
    );
  }

  protected async performBrowserFollowup(
    context: BrowserContext,
    _oldCredentials?: ApiCredentials
  ): Promise<ApiCredentials | null> {
    const page = context.pages()[0];
    if (!page) {
      throw new LoginFailedError('No page available in browser context.');
    }

    // Fail fast on anything unreachable: without this, a click blocked by a
    // leftover modal backdrop retries for Playwright's default half minute
    // before it reports a timeout.
    page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);

    // Sign-in happened on Zoom itself; the app is created on the Marketplace,
    // which the same session carries over to.
    await page.goto(ZOOM_MARKETPLACE_BUILD_URL);
    await waitForMarketplaceSidebar(page);

    const userInfo = await readMarketplaceUserInfo(page);
    if (userInfo === null) {
      throw new LoginFailedError(
        'The Zoom App Marketplace did not recognize the signed-in user. ' +
          'Sign in to https://marketplace.zoom.us/ in the browser window and try again.'
      );
    }
    if (
      userInfo.canBuildServerToServerOAuthApp === false ||
      userInfo.canBuildTwoLeggedOAuthApp === false
    ) {
      throw new ZoomAppCreationNotPermittedError();
    }

    const appKindDialog = await this.openAppKindDialog(page);
    await selectServerToServerAppKind(appKindDialog);
    await clickEnabledPrimaryDialogButton(page);

    await nameAndCreateApp(page, this.generateAppName());

    const appId = await waitForCreatedAppId(page);
    const credentials = await readAppCredentials(page, userInfo.email);

    await continueToScopesPage(page, appId, userInfo, this.appNamePrefix);
    await addAllScopes(page);
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
  readonly loginUrl = ZOOM_SIGN_IN_URL;
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
   * account is named after the user the app was created by, and failing that
   * by the app's (opaque) Zoom account id.
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
    if (!(apiCredentials instanceof ZoomServerToServerCredentials)) {
      return null;
    }
    return apiCredentials.accountEmail ?? apiCredentials.accountId;
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
