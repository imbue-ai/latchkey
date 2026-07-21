/**
 * Dropbox service implementation.
 */

import type { Response, BrowserContext, Page } from 'playwright';
import { ApiCredentials, OAuthCredentials } from '../apiCredentials/base.js';
import { typeLikeHuman } from '../playwrightUtils.js';
import {
  exchangeCodeForTokens,
  generateCodeChallenge,
  generateCodeVerifier,
  refreshAccessToken,
  startOAuthCallbackServer,
} from '../oauthUtils.js';
import {
  Service,
  BrowserFollowupServiceSession,
  LoginFailedError,
  isBrowserClosedError,
  LoginCancelledError,
} from './core/base.js';
import { tryParseJson } from '../apiCredentials/account.js';

const DEFAULT_TIMEOUT_MS = 8000;

// Dropbox deprecated non-expiring tokens, so we run the authorization-code flow
// with PKCE and `token_access_type=offline` to obtain a refresh token instead
// of relying on the app console's short-lived "Generate token" button.
const AUTHORIZE_ENDPOINT = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_ENDPOINT = 'https://api.dropboxapi.com/oauth2/token';

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
const IMPLICITLY_GRANTED_SCOPES = ['account_info.read', 'files.metadata.read'] as const;

// Time allowed for the user to approve the authorization request in the browser.
const AUTHORIZATION_TIMEOUT_MS = 120000;

class DropboxServiceSession extends BrowserFollowupServiceSession {
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
   * account.
   */
  private async selectOwningAccount(page: Page): Promise<void> {
    if (this.currentAccountUid !== undefined) {
      const currentAccount = page.locator(
        `input[name="_subject_uid"][value="${this.currentAccountUid}"]`
      );
      if ((await currentAccount.count()) > 0) {
        await currentAccount.check();
        return;
      }
    }

    const workAccount = page.locator('input#company[name="_subject_uid"]');
    const personalAccount = page.locator('input#personal[name="_subject_uid"]');

    if ((await workAccount.count()) > 0) {
      await workAccount.check();
      return;
    }

    if ((await personalAccount.count()) > 0) {
      await personalAccount.check();
    }
  }

  protected async performBrowserFollowup(
    context: BrowserContext,
    _oldCredentials?: ApiCredentials
  ): Promise<ApiCredentials | null> {
    const page = context.pages()[0];
    if (!page) {
      throw new LoginFailedError('No page available in browser context.');
    }

    await page.goto('https://www.dropbox.com/developers/apps/create');

    const scopedInput = page.locator('input#scoped');
    await scopedInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await scopedInput.click();

    const fullPermissionsInput = page.locator('input#full_permissions');
    await fullPermissionsInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await fullPermissionsInput.click();

    const appName = this.generateAppName();
    const appNameInput = page.locator('input#app-name');
    await appNameInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await typeLikeHuman(page, appNameInput, appName);

    await this.selectOwningAccount(page);

    const createButton = page.locator(
      '//button[@id="create-button" and @type="submit" and not(@disabled)]'
    );
    await createButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await createButton.click();

    await page.waitForURL(/https:\/\/www\.dropbox\.com\/developers\/apps\/info\b/, {
      timeout: DEFAULT_TIMEOUT_MS,
    });

    // Configure permissions before authorizing
    const permissionsTab = page.locator('a.c-tabs__label[data-hash="permissions"]');
    await permissionsTab.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await permissionsTab.click();

    // Enable all necessary permissions
    for (const permissionId of DROPBOX_SCOPES) {
      if (
        IMPLICITLY_GRANTED_SCOPES.includes(
          permissionId as (typeof IMPLICITLY_GRANTED_SCOPES)[number]
        )
      ) {
        continue;
      }
      const escapedPermissionId = permissionId.replace(/\./g, '\\.');
      const checkbox = page.locator(`input#${escapedPermissionId}`);
      await checkbox.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
      await checkbox.click();
    }

    // Submit permissions
    const submitButton = page.locator('button.permissions-submit-button');
    await submitButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await submitButton.click();

    // Wait for permissions to be saved
    await page.waitForTimeout(512);

    // Return to Settings tab to read the app key and register the redirect URI
    const settingsTab = page.locator('a.c-tabs__label[data-hash="settings"]');
    await settingsTab.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await settingsTab.click();

    const appKeyLocator = page.locator('.app-key');
    await appKeyLocator.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    const appKey = (await appKeyLocator.textContent())?.trim();
    if (!appKey) {
      throw new LoginFailedError('Failed to read Dropbox app key.');
    }

    return await this.authorizeApp(page, appKey);
  }

  /**
   * Run the authorization-code + PKCE flow against the freshly created app to
   * obtain a refresh token. The redirect URI is registered on the app first
   * because Dropbox requires it to match the authorization request exactly.
   */
  private async authorizeApp(page: Page, appKey: string): Promise<ApiCredentials> {
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
      const redirectUri = `http://localhost:${port.toString()}/oauth2callback`;

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

      // The finalize spinner runs in a separate tab that is kept in the
      // foreground. Bring the working page forward so the user can actually see
      // and confirm the authorization dialog.
      await page.bringToFront();
      await page.goto(authorizeUrl.toString());

      const code = await codePromise;

      const tokens = exchangeCodeForTokens(
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
        accessTokenExpiresAt
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
   * Register the localhost redirect URI on the app's OAuth 2 settings so the
   * subsequent authorization request is accepted.
   */
  private async registerRedirectUri(page: Page, redirectUri: string): Promise<void> {
    const redirectUriInput = page.locator('#oauth-add-uri-form input[name="oauth_uri"]');
    await redirectUriInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await typeLikeHuman(page, redirectUriInput, redirectUri);

    const addButton = page.locator('#oauth-add-uri-form input[type="submit"]:not([disabled])');
    await addButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await addButton.click();

    // Wait for the redirect URI to be saved before navigating away.
    await page.waitForTimeout(512);
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

  protected override parseAccountFromCredentialCheckBody(responseBody: string): string | null {
    const data = tryParseJson(responseBody) as {
      email?: string;
      account_id?: string;
    } | null;
    return data?.email ?? data?.account_id ?? null;
  }

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
  }

  override getSession(appNamePrefix: string): DropboxServiceSession {
    return new DropboxServiceSession(this, appNamePrefix);
  }

  override refreshCredentials(apiCredentials: ApiCredentials): Promise<ApiCredentials | null> {
    if (!(apiCredentials instanceof OAuthCredentials) || !apiCredentials.refreshToken) {
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

export const DROPBOX = new Dropbox();
