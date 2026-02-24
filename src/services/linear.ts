/**
 * Linear service implementation.
 */

import type { Response, BrowserContext } from 'playwright';
import { ApiCredentials, AuthorizationBare } from '../apiCredentials.js';
import { generateLatchkeyAppName, typeLikeHuman } from '../playwrightUtils.js';
import { Service, BrowserFollowupServiceSession, LoginFailedError } from './core/base.js';

const DEFAULT_TIMEOUT_MS = 8000;

// URL for creating a new personal API key (also used as login URL)
const LINEAR_NEW_API_KEY_URL = 'https://linear.app/imbue/settings/account/security/api-keys/new';

class LinearServiceSession extends BrowserFollowupServiceSession {
  private isLoggedIn = false;

  onResponse(response: Response): void {
    if (this.isLoggedIn) {
      return;
    }

    const request = response.request();
    // Empirically, Linear always sends this request. When not logged in,
    // the response only contains "data.organizationMeta". Otherwise it can
    // contain different things based on how exactly the user authenticated.
    if (request.url() === 'https://client-api.linear.app/graphql' && request.method() === 'POST') {
      if (response.status() === 200) {
        try {
          // Note: response.json() returns a Promise in Playwright
          response
            .json()
            .then((jsonData: unknown) => {
              const data = (jsonData as { data?: Record<string, unknown> }).data ?? {};
              if (Object.keys(data).some((key) => key !== 'organizationMeta')) {
                this.isLoggedIn = true;
              }
            })
            .catch(() => {
              // Ignore JSON parse errors
            });
        } catch {
          // Ignore errors
        }
      }
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

    await page.goto(LINEAR_NEW_API_KEY_URL);

    // Fill in the key name
    const keyName = generateLatchkeyAppName();
    const keyNameInput = page.locator('//*[@id="label"]');
    await keyNameInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await typeLikeHuman(page, keyNameInput, keyName);

    // Click the Create button
    const createButton = page.locator('button[type="submit"]');
    await createButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await createButton.click();

    // Wait for and extract the token from span element containing lin_api_ prefix
    const tokenElement = page.locator("span:text-matches('^lin_api_')");
    await tokenElement.waitFor({ timeout: DEFAULT_TIMEOUT_MS });

    const token = await tokenElement.textContent();
    if (token === null || token === '') {
      throw new LoginFailedError('Failed to extract token from Linear.');
    }

    await page.close();

    return new AuthorizationBare(token);
  }
}

export class Linear extends Service {
  readonly name = 'linear';
  readonly displayName = 'Linear';
  readonly baseApiUrls = ['https://api.linear.app/'] as const;
  readonly loginUrl = LINEAR_NEW_API_KEY_URL;
  readonly info = 'https://linear.app/developers/graphql';

  readonly credentialCheckCurlArguments = [
    '-X',
    'POST',
    '-H',
    'Content-Type: application/json',
    '-d',
    '{"query": "{ viewer { id } }"}',
    'https://api.linear.app/graphql',
  ] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: <token>"`;
  }

  override getSession(): LinearServiceSession {
    return new LinearServiceSession(this);
  }
}

export const LINEAR = new Linear();
