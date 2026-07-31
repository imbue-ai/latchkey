/**
 * ngrok service implementation.
 *
 * ngrok issues personal API keys from its dashboard, and the key value is
 * revealed exactly once at creation time (like Linear). We sign the user into
 * the dashboard, create a fresh API key on their behalf, and capture its value
 * from the creation response.
 *
 * Every ngrok API request must carry two headers: the bearer API key and a
 * constant `ngrok-version` header (https://ngrok.com/docs/api/#authentication).
 * We therefore store the credential as raw curl arguments that inject both, so
 * a plain `latchkey curl` to the ngrok API works without the caller having to
 * remember the version header.
 */

import type { Response, BrowserContext, Page } from 'playwright';
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

// The dashboard page that mints a new API key; the secret is shown once here.
const NGROK_NEW_API_KEY_URL = 'https://dashboard.ngrok.com/api-keys/new';

// The dashboard's own session-authenticated API. Traffic to it only happens
// once the user is signed in, so a 200 from it marks login as complete.
// (Verify the exact host/path against the live dashboard during end-to-end.)
const NGROK_DASHBOARD_API_PREFIX = 'https://dashboard.ngrok.com/api/';

// The dashboard request that creates an API key and returns its secret once.
const NGROK_API_KEY_CREATE_PATTERN = /\/api\/.*api[_-]?keys/i;

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
    const request = response.request();
    // Any authenticated dashboard API call proves we are past the login wall.
    if (request.url().startsWith(NGROK_DASHBOARD_API_PREFIX) && response.status() === 200) {
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

    // Start listening for the create response before triggering it: the full
    // API key is present in that response body exactly once, which is more
    // robust than scraping the reveal element (ngrok keys have no fixed prefix).
    const createdKey = this.captureCreatedApiKey(page);

    await page.goto(NGROK_NEW_API_KEY_URL);

    const description = this.generateAppName();
    const descriptionInput = page.locator('input[name="description"]');
    await descriptionInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await typeLikeHuman(page, descriptionInput, description);

    const createButton = page.locator('button[type="submit"]');
    await createButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await createButton.click();

    const apiKey = await createdKey;
    if (apiKey === null || apiKey === '') {
      throw new LoginFailedError('Failed to extract API key from ngrok.');
    }

    await page.close();
    return ngrokCredentials(apiKey);
  }

  /**
   * Resolve to the freshly created API key by reading it out of the dashboard's
   * create-key response, or null if that response never arrives.
   */
  private captureCreatedApiKey(page: Page): Promise<string | null> {
    return page
      .waitForResponse(
        (response) =>
          NGROK_API_KEY_CREATE_PATTERN.test(response.request().url()) &&
          response.request().method() === 'POST' &&
          response.status() >= 200 &&
          response.status() < 300,
        { timeout: DEFAULT_TIMEOUT_MS }
      )
      .then(async (response) => {
        const body = (await response.json()) as { token?: string; secret?: string };
        return body.token ?? body.secret ?? null;
      })
      .catch(() => null);
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
