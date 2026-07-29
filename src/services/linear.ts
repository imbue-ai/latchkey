/**
 * Linear service implementation.
 */

import type { Response, BrowserContext, Page } from 'playwright';
import { ApiCredentials, AuthorizationBare } from '../apiCredentials/base.js';
import { typeLikeHuman } from '../playwrightUtils.js';
import { Service, BrowserFollowupServiceSession, LoginFailedError } from './core/base.js';
import { fetchAccountFromEndpoint, tryParseJson } from '../apiCredentials/account.js';

const DEFAULT_TIMEOUT_MS = 8000;

const LINEAR_LOGIN_URL = 'https://linear.app/login';

// How long to wait for the post-login redirects to settle on a workspace URL.
const WORKSPACE_URL_TIMEOUT_MS = 30000;
// How long a workspace URL has to stay unchanged before it counts as final.
const WORKSPACE_URL_STABLE_MS = 1000;
const WORKSPACE_URL_POLL_INTERVAL_MS = 200;

// First path segments of linear.app URLs that are not workspace names.
const NON_WORKSPACE_PATH_SEGMENTS = new Set([
  'login',
  'logout',
  'auth',
  'oauth',
  'signup',
  'join',
  'invite',
  'magic',
]);

// GraphQL response keys that Linear also returns while the user is still
// anonymous or in the middle of logging in; seeing only these proves nothing.
const ANONYMOUS_GRAPHQL_RESPONSE_KEYS = new Set([
  'organizationMeta',
  'trackAnonymousEvent',
  'emailUserAccountAuthChallenge',
  'passkeyLoginStart',
]);

function parseWorkspaceName(url: string): string | null {
  const match = /^https:\/\/linear\.app\/([^/?#]+)/.exec(url);
  if (match === null) {
    return null;
  }
  const workspaceName = match[1] ?? '';
  return workspaceName === '' || NON_WORKSPACE_PATH_SEGMENTS.has(workspaceName)
    ? null
    : workspaceName;
}

function newApiKeyUrl(workspaceName: string): string {
  return `https://linear.app/${workspaceName}/settings/account/security/api-keys/new`;
}

/**
 * After login Linear redirects to a workspace page whose path is not stable
 * over time (e.g. `/agent`, `/inbox`), so instead of assuming a landing page we
 * wait for the redirect chain to settle on any workspace URL and take the
 * workspace name from it.
 */
async function waitForWorkspaceName(page: Page): Promise<string> {
  const deadline = Date.now() + WORKSPACE_URL_TIMEOUT_MS;
  let candidateName: string | null = null;
  let candidateSince = 0;

  while (Date.now() < deadline) {
    const workspaceName = parseWorkspaceName(page.url());
    if (workspaceName !== candidateName) {
      candidateName = workspaceName;
      candidateSince = Date.now();
    } else if (candidateName !== null && Date.now() - candidateSince >= WORKSPACE_URL_STABLE_MS) {
      return candidateName;
    }
    await page.waitForTimeout(WORKSPACE_URL_POLL_INTERVAL_MS);
  }

  throw new LoginFailedError(
    `Timed out waiting for a Linear workspace URL after login (last URL: ${page.url()}).`
  );
}

class LinearServiceSession extends BrowserFollowupServiceSession {
  private isLoggedIn = false;

  onResponse(response: Response): void {
    if (this.isLoggedIn) {
      return;
    }

    const request = response.request();
    // Empirically, when not logged in, the response data only contains keys from
    // ANONYMOUS_GRAPHQL_RESPONSE_KEYS. Otherwise it can contain many different things.
    if (request.url() === 'https://client-api.linear.app/graphql' && request.method() === 'POST') {
      if (response.status() === 200) {
        try {
          // Note: response.json() returns a Promise in Playwright
          response
            .json()
            .then((jsonData: unknown) => {
              const data = (jsonData as { data?: Record<string, unknown> }).data ?? {};
              if (Object.keys(data).some((key) => !ANONYMOUS_GRAPHQL_RESPONSE_KEYS.has(key))) {
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

    const workspaceName = await waitForWorkspaceName(page);
    await page.goto(newApiKeyUrl(workspaceName));

    // Fill in the key name
    const keyName = this.generateAppName();
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
  readonly loginUrl = LINEAR_LOGIN_URL;
  readonly info = 'https://linear.app/developers/graphql';

  readonly credentialCheckCurlArguments = [
    '-X',
    'POST',
    '-H',
    'Content-Type: application/json',
    '-d',
    '{"query": "{ viewer { id email } }"}',
    'https://api.linear.app/graphql',
  ] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: <token>"`;
  }

  override getAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    return fetchAccountFromEndpoint(
      apiCredentials,
      this.credentialCheckCurlArguments,
      (responseBody) => {
        const data = tryParseJson(responseBody) as {
          data?: { viewer?: { email?: string; id?: string } };
        } | null;
        return data?.data?.viewer?.email ?? data?.data?.viewer?.id ?? null;
      }
    );
  }

  override getSession(appNamePrefix: string): LinearServiceSession {
    return new LinearServiceSession(this, appNamePrefix);
  }
}

export const LINEAR = new Linear();
