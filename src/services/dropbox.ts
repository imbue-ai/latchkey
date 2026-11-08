/**
 * Dropbox service implementation.
 */

import type { Response, BrowserContext, Page } from 'playwright';
import { ApiCredentials, OAuthCredentials } from '../apiCredentials/base.js';
import { typeLikeHuman } from '../playwrightUtils.js';
import {
  buildAuthorizationState,
  buildLoopbackRedirectUri,
  exchangeCodeForTokens,
  generateCodeChallenge,
  generateCodeVerifier,
  readRedirectUriOverride,
  refreshAccessToken,
  startOAuthCallbackServer,
} from '../oauthUtils.js';
import {
  Service,
  BrowserFollowupServiceSession,
  FollowupWork,
  LoginFailedError,
  isBrowserClosedError,
  LoginCancelledError,
  DynamicClientPrepareInputSchema,
  buildDynamicClientPreparation,
  buildPreparedCredentials,
} from './core/base.js';
import { fetchAccountFromEndpoint, tryParseJson } from '../apiCredentials/account.js';

const DEFAULT_TIMEOUT_MS = 20000;

// Dropbox deprecated non-expiring tokens, so we run the authorization-code flow
// with PKCE and `token_access_type=offline` to obtain a refresh token instead
// of relying on the app console's short-lived "Generate token" button.
const AUTHORIZE_ENDPOINT = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_ENDPOINT = 'https://api.dropboxapi.com/oauth2/token';

// Dropbox retired the legacy App Console (/developers/apps/...) in favour of the
// new Developer Console (/developers/console/apps/...). The create-app page is a
// progressive single-page form, and the per-app settings live at separate routes
// (/settings, /permissions) instead of tab anchors. These are the current URLs.
const CREATE_APP_URL = 'https://www.dropbox.com/developers/console/apps/create';
const appConsoleUrl = (appId: string, section: 'settings' | 'permissions') =>
  `https://www.dropbox.com/developers/console/apps/${appId}/${section}`;

// Scopes enabled on the created app. The same list is requested during
// authorization so the resulting token carries exactly these permissions.
const DROPBOX_SCOPES = [
  'account_info.read',
  'files.metadata.write',
  'files.metadata.read',
  'files.content.write',
  'files.content.read',
  'sharing.read',
  'sharing.write',
  'file_requests.read',
  'file_requests.write',
  'contacts.read',
  'contacts.write',
] as const;
// The legacy App Console left a handful of scopes (account_info.read,
// files.metadata.read) implicitly granted with no checkbox to tick. The new
// Developer Console exposes every scope as an explicit checkbox, so we simply
// check all of DROPBOX_SCOPES instead of maintaining an implicit-grant list.

// Time allowed for the user to approve the authorization request in the browser.
const AUTHORIZATION_TIMEOUT_MS = 120000;
const CODE_ARRIVED = Symbol('codeArrived');

// Time allowed for the user to accept the Dropbox API Terms and Conditions.
const TERMS_OF_SERVICE_USER_INTERACTION_TIMEOUT_MS = 10 * 60 * 1000;

// Distance from the top of the viewport at which the terms checkbox is parked:
// far enough to clear the Dropbox top bar, close enough that the unrelated app
// creation fields above it stay out of sight.
const TERMS_OF_SERVICE_VIEWPORT_TOP_MARGIN_PX = 132;

// Dropbox keeps the "Create app" button disabled until the form is complete.
// The new Developer Console gives the button no stable id, so it is selected by
// its visible text and enabled state.
const ENABLED_CREATE_APP_BUTTON_SELECTOR =
  'button[type=submit]:has-text("Create app"):not([disabled])';

// The DOM library is not enabled for this project, so browser-side callbacks
// describe the few DOM members they actually use.
interface ScrollableElement {
  readonly ownerDocument: {
    readonly defaultView: { scrollBy(options: { top: number }): void } | null;
  };
  getBoundingClientRect(): { readonly top: number };
}

class DropboxServiceSession extends BrowserFollowupServiceSession {
  protected readonly followupWork = FollowupWork.CreateApp;
  private isLoggedIn = false;
  private currentAccountUid?: string;

  onResponse(response: Response): void {
    if (this.isLoggedIn) {
      return;
    }

    const request = response.request();
    const url = request.url();
    if (!url.startsWith('https://www.dropbox.com/')) {
      return;
    }

    // Require 2XX response to ensure the session is valid (not expired)
    const status = response.status();
    if (status < 200 || status >= 300) {
      return;
    }

    const headers = request.headers();
    const uidHeader = headers['x-dropbox-uid'];
    if (uidHeader === undefined || uidHeader === '-1') {
      return;
    }

    // Remember the currently active account so the app can be created under the
    // account the user is actually logged in as when several are linked.
    this.currentAccountUid = uidHeader;
    this.isLoggedIn = true;
  }

  protected isLoginComplete(): boolean {
    return this.isLoggedIn;
  }

  /**
   * When more than one account is linked, Dropbox asks which account should own
   * the app before enabling the "Create app" button. Prefer the account the
   * user is currently logged in as, then the work account, then the personal
   * account. With a single linked account there is no choice to make: the page
   * only carries a hidden `_subject_uid` field, which must not be clicked.
   */
  private async selectOwningAccount(page: Page): Promise<void> {
    if (this.currentAccountUid !== undefined) {
      const currentAccount = page.locator(
        `input[type="radio"][name="_subject_uid"][value="${this.currentAccountUid}"]`
      );
      if ((await currentAccount.count()) > 0) {
        await currentAccount.check();
        return;
      }
    }

    const workAccount = page.locator('input#company[type="radio"][name="_subject_uid"]');
    const personalAccount = page.locator('input#personal[type="radio"][name="_subject_uid"]');

    if ((await workAccount.count()) > 0) {
      await workAccount.check();
      return;
    }

    if ((await personalAccount.count()) > 0) {
      await personalAccount.check();
    }
  }

  /**
   * Accounts that have not accepted the Dropbox API Terms and Conditions yet
   * see a checkbox that keeps the "Create app" button disabled.
   *
   * The new Developer Console renders this as a single
   * `input#create-app-terms` checkbox inside the create-app form (present only
   * for accounts that still need to accept). Accepting the API Terms is an
   * inherent requirement of the app creation the operator just initiated, so we
   * tick it on their behalf rather than blocking on a manual step.
   *
   * The legacy App Console instead wrapped the checkbox in an
   * `#accept-tos-wrapper` that it hid for accounts that had already accepted;
   * there, accepting the terms is the user's decision, so we surface the page
   * with the checkbox parked just below the top bar and wait (up to the long
   * ToS timeout) for the user to tick it. Kept for completeness even though the
   * legacy console has been retired.
   *
   * Waiting for the "Create app" button to become enabled (in the legacy path)
   * rather than for the checkbox state keeps the flow going even if Dropbox
   * concludes the terms are not needed after all and hides the wrapper again.
   */
  private async waitForTermsOfServiceAcceptance(page: Page): Promise<void> {
    // New Developer Console.
    const newTermsCheckbox = page.locator('input#create-app-terms[type="checkbox"]');
    if ((await newTermsCheckbox.count()) > 0 && !(await newTermsCheckbox.isChecked())) {
      await page.bringToFront();
      await newTermsCheckbox.check();
    }

    // Legacy App Console (retired, kept for completeness).
    const termsWrapper = page.locator('#accept-tos-wrapper');
    if (!(await termsWrapper.isVisible())) {
      return;
    }

    const legacyTermsCheckbox = page.locator('input#accept-tos[type="checkbox"]');
    if (await legacyTermsCheckbox.isChecked()) {
      return;
    }

    try {
      await page.bringToFront();
      // Scrolling by the element's own offset (instead of scrollIntoView)
      // keeps the requested top margin: the browser clamps at the end of the
      // document, which would otherwise hide the checkbox behind the top bar.
      await termsWrapper.evaluate((element, topMargin: number) => {
        const wrapper = element as unknown as ScrollableElement;
        wrapper.ownerDocument.defaultView?.scrollBy({
          top: wrapper.getBoundingClientRect().top - topMargin,
        });
      }, TERMS_OF_SERVICE_VIEWPORT_TOP_MARGIN_PX);

      await page.locator(ENABLED_CREATE_APP_BUTTON_SELECTOR).waitFor({
        timeout: TERMS_OF_SERVICE_USER_INTERACTION_TIMEOUT_MS,
      });
    } catch (error: unknown) {
      if (error instanceof Error && isBrowserClosedError(error)) {
        throw new LoginCancelledError();
      }
      throw error;
    }

    await this.spinnerPage?.bringToFront();
  }

  protected async performBrowserFollowup(
    context: BrowserContext,
    oldCredentials?: ApiCredentials
  ): Promise<ApiCredentials | null> {
    const page = context.pages()[0];
    if (!page) {
      throw new LoginFailedError('No page available in browser context.');
    }

    await page.goto(CREATE_APP_URL, {
      waitUntil: 'domcontentloaded',
    });

    // Step 1 of the create-app form: "Choose an API" -> Scoped access.
    const scopedInput = page.locator('input#api-scoped');
    await scopedInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await scopedInput.click();

    // Step 2: "Choose the type of access you need" -> Full Dropbox.
    const fullPermissionsInput = page.locator('input#access-full_permissions');
    await fullPermissionsInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await fullPermissionsInput.click();

    // Step 3: "Name your app".
    const appName = this.generateAppName();
    const appNameInput = page.locator('input#app-name');
    await appNameInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await typeLikeHuman(page, appNameInput, appName);

    await this.selectOwningAccount(page);
    await this.waitForTermsOfServiceAcceptance(page);

    const createButton = page.locator(ENABLED_CREATE_APP_BUTTON_SELECTOR);
    await createButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await createButton.click();

    // The new console lands on /developers/console/apps/<app-id>/settings.
    await page.waitForURL(
      /https:\/\/www\.dropbox\.com\/developers\/console\/apps\/[^/]+\/settings/,
      {
        timeout: DEFAULT_TIMEOUT_MS,
      }
    );

    const appIdMatch = /\/developers\/console\/apps\/([^/]+)\//.exec(page.url());
    if (!appIdMatch?.[1]) {
      throw new LoginFailedError('Failed to read the Dropbox app id from the console URL.');
    }
    const appId = appIdMatch[1];

    // Configure permissions before authorizing. The new console moved scopes to
    // a dedicated /permissions route with one checkbox per scope (id
    // `permission-<scope>`), saved with a "Save changes" button.
    await page.goto(appConsoleUrl(appId, 'permissions'), {
      waitUntil: 'domcontentloaded',
    });

    // Enable all necessary permissions.
    for (const permissionId of DROPBOX_SCOPES) {
      const escapedPermissionId = permissionId.replace(/\./g, '\\.');
      const checkbox = page.locator(`input#permission-${escapedPermissionId}`);
      await checkbox.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
      await checkbox.check();
    }

    // Submit permissions.
    const submitButton = page.locator('button:has-text("Save changes"):not([disabled])');
    await submitButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await submitButton.click();

    // Wait for permissions to be saved before navigating away.
    await page.waitForTimeout(512);

    // Return to Settings to read the app key and register the redirect URI.
    await page.goto(appConsoleUrl(appId, 'settings'), {
      waitUntil: 'domcontentloaded',
    });

    const appKey = await this.readAppKey(page);
    if (!appKey) {
      throw new LoginFailedError('Failed to read Dropbox app key.');
    }

    return await this.authorizeApp(page, appKey, oldCredentials);
  }

  /**
   * Run the authorization-code + PKCE flow against the freshly created app to
   * obtain a refresh token. The redirect URI is registered on the app first
   * because Dropbox requires it to match the authorization request exactly.
   *
   * A prepared redirect URI (set via `latchkey auth prepare dropbox
   * '{"redirectUri":"https://imbue-ai.github.io/oauth-callback"}'`) and stored on the
   * credentials) wins over the per-run loopback URI. The page at that URI must
   * forward the authorization result to latchkey's loopback callback, whose
   * port it reads out of the `state` parameter (see `buildAuthorizationState`);
   * this is the same bounce contract the remote-MCP services use. Using a
   * fixed https URI there avoids the http-only "Add redirect URI?" confirmation
   * dialog Dropbox otherwise raises for a loopback URI, which makes the flow
   * run with zero manual clicks once the operator is logged in.
   */
  private async authorizeApp(
    page: Page,
    appKey: string,
    oldCredentials?: ApiCredentials
  ): Promise<ApiCredentials> {
    const abortController = new AbortController();
    const closeHandler = () => {
      abortController.abort();
    };
    page.on('close', closeHandler);
    page.context().on('close', closeHandler);

    try {
      const { port, codePromise } = await startOAuthCallbackServer(
        AUTHORIZATION_TIMEOUT_MS,
        abortController.signal
      );
      // A prepared redirect URI wins over the loopback one; the page it serves
      // forwards the authorization result to the loopback callback, whose
      // port it reads out of the `state` parameter below.
      const redirectUriOverride = readRedirectUriOverride(oldCredentials);
      const redirectUri = redirectUriOverride ?? buildLoopbackRedirectUri(port);

      await this.registerRedirectUri(page, redirectUri);

      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      const authorizeUrl = new URL(AUTHORIZE_ENDPOINT);
      authorizeUrl.searchParams.set('client_id', appKey);
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('redirect_uri', redirectUri);
      authorizeUrl.searchParams.set('token_access_type', 'offline');
      authorizeUrl.searchParams.set('code_challenge', codeChallenge);
      authorizeUrl.searchParams.set('code_challenge_method', 'S256');
      authorizeUrl.searchParams.set('scope', DROPBOX_SCOPES.join(' '));
      // Carry the loopback port in `state` so a prepared redirect-URI page can
      // forward the result to the callback it could not have known in advance.
      // Sent for loopback logins too, so both paths look alike.
      authorizeUrl.searchParams.set('state', buildAuthorizationState(port));

      // The finalize spinner runs in a separate tab that is kept in the
      // foreground. Bring the working page forward so the user can actually see
      // and confirm the authorization dialog.
      await page.bringToFront();
      await page.goto(authorizeUrl.toString(), { waitUntil: 'domcontentloaded' });

      // The app was just created by the operator on their own account, so
      // granting is the intended action; auto-click through the two consent
      // screens ("Before you connect this app..." -> Continue, then
      // "[app] would like to: ..." -> Allow) that gate the authorization code.
      await this.authorizeConsent(page, codePromise);

      const code = await codePromise;

      const tokens = await exchangeCodeForTokens(
        TOKEN_ENDPOINT,
        code,
        appKey,
        '', // public client using PKCE, no secret
        redirectUri,
        codeVerifier
      );

      const accessTokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

      await page.close();

      return new OAuthCredentials(
        appKey,
        '', // public client, no secret stored
        tokens.access_token,
        tokens.refresh_token,
        accessTokenExpiresAt,
        undefined,
        // Carried over so a re-login reuses the prepared redirect URI.
        redirectUriOverride
      );
    } catch (error: unknown) {
      if (error instanceof Error && isBrowserClosedError(error)) {
        throw new LoginCancelledError();
      }
      throw error;
    } finally {
      page.off('close', closeHandler);
      page.context().off('close', closeHandler);
    }
  }

  /**
   * Register the redirect URI on the app's OAuth 2 settings so the subsequent
   * authorization request is accepted.
   *
   * The new Developer Console renders the redirect-URI field with an
   * `aria-label` rather than a stable id/name, inside a form whose only submit
   * button is labelled "Add" (disabled until a URI is typed). For a http
   * (loopback) URI, clicking "Add" does not persist it directly: it opens a
   * `[role=dialog]` confirmation ("Add redirect URI?… Please don't add URIs
   * whose contents aren't under your control.") whose "Add redirect URI" button
   * must be clicked to actually save the URI. An https URI (such as a
   * prepared `https://imbue-ai.github.io/oauth-callback` bounce page) does not raise that
   * warning, so the dialog is absent and the confirmation is skipped.
   */
  private async registerRedirectUri(page: Page, redirectUri: string): Promise<void> {
    const redirectUriInput = page.locator('input[aria-label="OAuth redirect URI"]');
    await redirectUriInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await typeLikeHuman(page, redirectUriInput, redirectUri);

    const redirectForm = page
      .locator('form')
      .filter({ has: page.locator('input[aria-label="OAuth redirect URI"]') });
    const addButton = redirectForm.locator('button[type=submit]:not([disabled])');
    await addButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await addButton.click();

    // Confirm the non-https redirect URI in the dialog that "Add" opens, if it
    // opens. An https URI is saved directly with no confirmation dialog, so a
    // timeout here is expected for the prepared-redirect-URI (bounce) path.
    const confirmButton = page
      .getByRole('dialog')
      .getByRole('button', { name: 'Add redirect URI' });
    try {
      await confirmButton.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS });
      await confirmButton.click();
    } catch {
      // No confirmation dialog (https URI saved directly, or already present).
    }

    // Wait for the redirect URI to be saved before navigating away.
    await page.waitForTimeout(512);
  }

  /**
   * Click through the Dropbox OAuth consent screens on the operator's behalf.
   *
   * The app was just created by the operator on their own account, so granting
   * is the intended action. The new console presents two gated screens before
   * issuing the authorization code: a "Before you connect this app..." warning
   * with a Continue button, and a "[app] would like to: ..." permission grant
   * with an Allow button. Each is clicked best-effort: a screen may be skipped
   * (e.g. the app was already authorized for this account, so Dropbox
   * redirects straight to the callback), so every wait is raced against the
   * authorization code arriving at the loopback server. Without the race, the
   * wait for a button that will never appear on the callback's bare "OK" page
   * would stall the login for the full button timeout.
   */
  private async authorizeConsent(page: Page, codePromise: Promise<string>): Promise<void> {
    const codeArrived = codePromise.then(() => CODE_ARRIVED);
    for (const label of ['Continue', 'Allow']) {
      const button = page.getByRole('button', { name: label });
      try {
        const outcome = await Promise.race([
          button.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS }),
          codeArrived,
        ]);
        if (outcome === CODE_ARRIVED) {
          return;
        }
        await button.click();
      } catch {
        // Screen missing or the code promise settled; the caller awaits it.
        return;
      }
    }
  }

  /**
   * Read the app key from the Settings page.
   *
   * The new console wraps the value in a `<code>` element inside the settings
   * row that also holds the "App key" label. Class names are CSS-modules-hashed
   * (so unstable across builds), so we locate the label by its visible text and
   * then walk up to the nearest ancestor that exposes the `<code>` value — all
   * via locators, since the project does not link the DOM lib for in-page
   * callbacks.
   */
  private async readAppKey(page: Page): Promise<string | null> {
    const label = page.getByText('App key', { exact: true }).first();
    const code = label.locator('xpath=ancestor::*[.//code][1]').locator('code').first();
    return (await code.textContent())?.trim() ?? null;
  }
}

export class Dropbox extends Service {
  readonly name = 'dropbox';
  readonly displayName = 'Dropbox';
  readonly baseApiUrls = [
    'https://api.dropboxapi.com/',
    'https://content.dropboxapi.com/',
    'https://notify.dropboxapi.com/',
  ] as const;
  readonly loginUrl = 'https://www.dropbox.com/login';
  readonly info =
    'https://www.dropbox.com/developers/documentation/http/documentation. ' +
    'Use api.dropboxapi.com for RPC-style endpoints and content.dropboxapi.com for content upload/download.';

  // get_current_account both validates the token and identifies the account.
  // The account_info.read scope it needs is always granted (it is mandatory in
  // the Dropbox App Console and included in DROPBOX_SCOPES for browser login).
  readonly credentialCheckCurlArguments = [
    '-X',
    'POST',
    'https://api.dropboxapi.com/2/users/get_current_account',
  ] as const;

  override getAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    return fetchAccountFromEndpoint(
      apiCredentials,
      this.credentialCheckCurlArguments,
      (responseBody) => {
        const data = tryParseJson(responseBody) as {
          email?: string;
          account_id?: string;
        } | null;
        return data?.email ?? data?.account_id ?? null;
      }
    );
  }

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
  }

  /**
   * Dropbox creates its OAuth app (and thus the client id) at login, so the
   * only thing that can be prepared in advance is the redirect URI — typically
   * a fixed `https://imbue-ai.github.io/oauth-callback` bounce page that forwards the
   * authorization result to latchkey's loopback callback (whose port it reads
   * out of the `state` parameter). Using one avoids the per-run http loopback
   * URI and the "Add redirect URI?" confirmation dialog it triggers, so login
   * runs end-to-end with no manual clicks once the operator is logged in. See
   * {@link DynamicClientPrepareInputSchema}.
   */
  override prepareFromJson(parsedJson: unknown): ApiCredentials {
    return buildPreparedCredentials(
      this.name,
      DynamicClientPrepareInputSchema,
      parsedJson,
      buildDynamicClientPreparation
    );
  }

  override getSession(appNamePrefix: string): DropboxServiceSession {
    return new DropboxServiceSession(this, appNamePrefix);
  }

  override async refreshCredentials(
    apiCredentials: ApiCredentials
  ): Promise<ApiCredentials | null> {
    if (!(apiCredentials instanceof OAuthCredentials) || !apiCredentials.refreshToken) {
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
      apiCredentials.refreshTokenExpiresAt,
      // Preserve a prepared redirect URI across refresh so the next login can
      // reuse the bounce page.
      apiCredentials.redirectUri
    );
  }
}

export const DROPBOX = new Dropbox();
