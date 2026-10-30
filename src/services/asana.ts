/**
 * Asana service implementation.
 */

import type { Response, BrowserContext, Page } from 'playwright';
import { ApiCredentials, AuthorizationBearer } from '../apiCredentials/base.js';
import { typeLikeHuman } from '../playwrightUtils.js';
import {
  Service,
  BrowserFollowupServiceSession,
  FollowupWork,
  LoginFailedError,
  type ManualCredentialForm,
} from './core/base.js';
import { fetchAccountFromEndpoint, tryParseJson } from '../apiCredentials/account.js';

const DEFAULT_TIMEOUT_MS = 8000;

// The developer console lists the user's apps and personal access tokens. It
// also doubles as the login URL: visited while logged out, Asana redirects to
// the sign-in page and returns here afterwards.
const ASANA_DEVELOPER_CONSOLE_URL = 'https://app.asana.com/0/my-apps';

const ASANA_API_URL_PREFIX = 'https://app.asana.com/api/1.0/';

// The console's buttons are divs with ARIA roles. The one opening the token
// dialog is the only secondary button under the page root (`#asana`) with an
// `aria-disabled` attribute: the header's "Launch Asana" has none, and dialogs
// are rendered in a separate layer outside the page root.
const CREATE_TOKEN_BUTTON_SELECTOR =
  '#asana [role="button"][data-testid="SecondaryButton"][aria-disabled]';
const DIALOG_SELECTOR = '[role="dialog"]';

class AsanaServiceSession extends BrowserFollowupServiceSession {
  protected readonly followupWork = FollowupWork.CreateApiToken;
  override readonly manualCredentialForm: ManualCredentialForm = {
    instructions:
      `To finish by hand, open ${ASANA_DEVELOPER_CONSOLE_URL} in the other tab of this ` +
      'window, click "Create new token" under Personal access tokens, name the token, ' +
      'accept the API terms and create it. The token is shown once, right after creation.',
    fields: [{ name: 'token', label: 'Personal access token' }],
    buildCredentials: (values) => new AuthorizationBearer(values.get('token')),
  };
  private isLoggedIn = false;

  onResponse(response: Response): void {
    if (this.isLoggedIn) {
      return;
    }

    // The Asana web app calls its own API with cookie auth once the user is
    // signed in; a successful call proves the login (as with Todoist).
    if (response.request().url().startsWith(ASANA_API_URL_PREFIX) && response.status() === 200) {
      this.isLoggedIn = true;
    }
  }

  protected isLoginComplete(): boolean {
    return this.isLoggedIn;
  }

  /**
   * The developer console may render without calling the API, so the login
   * also counts as complete once the console shows the token creation button.
   */
  override async whileWaitingForLogin(page: Page): Promise<void> {
    if (this.isLoggedIn || !page.url().startsWith(ASANA_DEVELOPER_CONSOLE_URL)) {
      return;
    }
    try {
      if ((await page.locator(CREATE_TOKEN_BUTTON_SELECTOR).count()) > 0) {
        this.isLoggedIn = true;
      }
    } catch {
      // The page may be mid-navigation; the next poll looks again.
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

    await page.goto(ASANA_DEVELOPER_CONSOLE_URL, { waitUntil: 'domcontentloaded' });

    const createTokenButton = page.locator(CREATE_TOKEN_BUTTON_SELECTOR);
    await createTokenButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await createTokenButton.click();

    // The "Create new token" dialog: a name, the API terms checkbox and a
    // primary button that stays disabled until both are filled in.
    const dialog = page.locator(DIALOG_SELECTOR);
    const tokenNameInput = dialog.locator('input[type="text"]');
    await tokenNameInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await typeLikeHuman(page, tokenNameInput, this.generateAppName());
    await dialog.locator('input[type="checkbox"]').check();

    const submitButton = dialog.locator('[role="button"][data-testid="PrimaryButton"]');
    await submitButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await submitButton.click();

    // The dialog turns into "Token details", where the token is shown once in
    // a read-only input. Read it from the element value (never the clipboard).
    const tokenInput = dialog.locator('input[readonly]');
    await tokenInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });

    const token = (await tokenInput.inputValue()).trim();
    if (token === '') {
      throw new LoginFailedError('Failed to extract token from Asana.');
    }

    await page.close();

    return new AuthorizationBearer(token);
  }
}

export class Asana extends Service {
  readonly name = 'asana';
  readonly displayName = 'Asana';
  readonly baseApiUrls = ['https://app.asana.com/api/'] as const;
  readonly loginUrl = ASANA_DEVELOPER_CONSOLE_URL;
  readonly info = 'https://developers.asana.com/reference/rest-api-reference.';

  // /users/me both validates the token and identifies the account.
  readonly credentialCheckCurlArguments = [`${ASANA_API_URL_PREFIX}users/me`] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
  }

  override getAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    return fetchAccountFromEndpoint(
      apiCredentials,
      this.credentialCheckCurlArguments,
      (responseBody) => {
        const data = tryParseJson(responseBody) as {
          data?: { email?: string; name?: string; gid?: string };
        } | null;
        return data?.data?.email ?? data?.data?.name ?? data?.data?.gid ?? null;
      }
    );
  }

  override getSession(appNamePrefix: string): AsanaServiceSession {
    return new AsanaServiceSession(this, appNamePrefix);
  }
}

export const ASANA = new Asana();
