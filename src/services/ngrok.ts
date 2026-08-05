/**
 * ngrok service implementation.
 *
 * ngrok issues personal API keys from its dashboard, and the key value is
 * revealed exactly once at creation time (like Linear). We sign the user into
 * the dashboard, create a fresh API key on their behalf, and read its value
 * from the one-time reveal dialog.
 *
 * Every ngrok API request must carry two headers: the bearer API key and a
 * constant `ngrok-version` header (https://ngrok.com/docs/api/#authentication).
 * We therefore store the credential as raw curl arguments that inject both, so
 * a plain `latchkey curl` to the ngrok API works without the caller having to
 * remember the version header.
 */

import type { Response, BrowserContext } from 'playwright';
import { ApiCredentials, RawCurlCredentials } from '../apiCredentials/base.js';
import { typeLikeHuman } from '../playwrightUtils.js';
import {
  Service,
  BrowserFollowupServiceSession,
  FollowupWork,
  LoginFailedError,
} from './core/base.js';

const DEFAULT_TIMEOUT_MS = 8000;

// The ngrok REST API. Every request must also send the `ngrok-version` header.
const NGROK_API_BASE_URL = 'https://api.ngrok.com/';
const NGROK_API_VERSION = '2';

const NGROK_LOGIN_URL = 'https://dashboard.ngrok.com/login';

// Navigating here opens the "New API Key" dialog directly; the secret is shown
// once in that dialog after creation.
const NGROK_NEW_API_KEY_URL = 'https://dashboard.ngrok.com/api-keys/new';

// Dashboard host, and the first path segments served before the user is signed
// in. A dashboard document response on any *other* path only happens once login
// has succeeded, so we use it as the login-complete signal.
const NGROK_DASHBOARD_HOST = 'dashboard.ngrok.com';
const NGROK_PRE_LOGIN_PATH_PATTERN = /^\/(login|signup|signin|auth|sso|oauth|verify|mfa)/i;

/**
 * Build the stored credential: a bearer API key plus the mandatory
 * `ngrok-version` header, expressed as raw curl arguments so both are injected
 * into every request.
 */
function ngrokCredentials(apiKey: string): RawCurlCredentials {
  return new RawCurlCredentials([
    '-H',
    `Authorization: Bearer ${apiKey}`,
    '-H',
    `ngrok-version: ${NGROK_API_VERSION}`,
  ]);
}

class NgrokServiceSession extends BrowserFollowupServiceSession {
  protected readonly followupWork = FollowupWork.CreateApiToken;
  private isLoggedIn = false;

  onResponse(response: Response): void {
    if (this.isLoggedIn) {
      return;
    }
    // The dashboard is a client-side app; after a successful sign-in the browser
    // lands on a dashboard document that is not one of the auth pages (works the
    // same whether the user signs in with a password or an SSO provider, since
    // the final redirect target is always a dashboard page).
    if (response.request().resourceType() !== 'document') {
      return;
    }
    let url: URL;
    try {
      url = new URL(response.url());
    } catch {
      return;
    }
    if (url.hostname !== NGROK_DASHBOARD_HOST) {
      return;
    }
    if (NGROK_PRE_LOGIN_PATH_PATTERN.test(url.pathname)) {
      return;
    }
    if (response.status() >= 200 && response.status() < 400) {
      this.isLoggedIn = true;
    }
  }

  protected isLoginComplete(): boolean {
    return this.isLoggedIn;
  }

  protected async performBrowserFollowup(
    context: BrowserContext,
    _oldCredentials?: ApiCredentials
  ): Promise<ApiCredentials | null> {
    const page = context.pages()[0];
    if (!page) {
      throw new LoginFailedError('No page available in browser context.');
    }

    await page.goto(NGROK_NEW_API_KEY_URL);

    // The description field comes prefilled; replace it with our own label so
    // the user can recognize and revoke the key later.
    const description = this.generateAppName();
    const descriptionInput = page.locator('input[name="description"]');
    await descriptionInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await descriptionInput.fill('');
    await typeLikeHuman(page, descriptionInput, description);

    const createButton = page.locator('button[type="submit"]');
    await createButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await createButton.click();

    // The created key is revealed exactly once, inside the success dialog's
    // <pre> element. ngrok keys have no fixed prefix, so we read that element
    // directly rather than matching on the token text.
    const tokenElement = page.locator('[role="dialog"] pre');
    await tokenElement.waitFor({ timeout: DEFAULT_TIMEOUT_MS });

    const token = (await tokenElement.textContent())?.trim();
    if (token === undefined || token === '') {
      throw new LoginFailedError('Failed to extract API key from ngrok.');
    }

    await page.close();
    return ngrokCredentials(token);
  }
}

export class Ngrok extends Service {
  readonly name = 'ngrok';
  readonly displayName = 'ngrok';
  readonly baseApiUrls = [NGROK_API_BASE_URL] as const;
  readonly loginUrl = NGROK_LOGIN_URL;
  readonly info = 'https://ngrok.com/docs/api/';

  // Listing API keys returns 200 for any valid key; the stored credential adds
  // the required Authorization and ngrok-version headers.
  readonly credentialCheckCurlArguments = ['https://api.ngrok.com/api_keys'] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>" -H "ngrok-version: ${NGROK_API_VERSION}"`;
  }

  // An ngrok API key carries no queryable identity endpoint, so the account is
  // left as the default rather than guessed.
  override getAccount(_apiCredentials: ApiCredentials): Promise<string | null> {
    return Promise.resolve(null);
  }

  override getSession(appNamePrefix: string): NgrokServiceSession {
    return new NgrokServiceSession(this, appNamePrefix);
  }
}

export const NGROK = new Ngrok();
