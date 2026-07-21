/**
 * GitHub service implementation.
 */

import type { Response, BrowserContext } from 'playwright';
import { ApiCredentials, AuthorizationBearer } from '../apiCredentials/base.js';
import { typeLikeHuman } from '../playwrightUtils.js';
import { Service, BrowserFollowupServiceSession, LoginFailedError } from './core/base.js';
import { tryParseJson } from '../apiCredentials/account.js';

const DEFAULT_TIMEOUT_MS = 8000;

// URL for creating a new personal access token (also used as login URL to trigger sudo)
const GITHUB_NEW_TOKEN_URL = 'https://github.com/settings/tokens/new';

/**
 * Matches the GitHub smart-HTTP endpoints used by git over HTTPS, as opposed to
 * the REST API or a regular website page. The git client only ever talks to
 * `<owner>/<repo>[.git]/info/refs`, `.../git-upload-pack` and
 * `.../git-receive-pack`, so matching those endpoints reliably distinguishes
 * actual git operations from ordinary repository web pages (which should not be
 * authenticated as git).
 */
const GITHUB_GIT_OPERATION_URL_PATTERN =
  /^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:info\/refs|git-upload-pack|git-receive-pack)(?:[/?]|$)/;

export class UnexpectedGithubCredentialsError extends Error {
  constructor() {
    super('Expected GitHub credentials of the "Authorization: Bearer" form for repository access.');
    this.name = 'UnexpectedGithubCredentialsError';
  }
}

/**
 * GitHub token credentials injected via curl's `-u` flag, suitable for git
 * operations over HTTPS (the smart HTTP protocol uses HTTP basic auth). This
 * credential form is produced on the fly from a stored bearer token and is
 * never persisted.
 */
export class GithubTokenBasicAuth implements ApiCredentials {
  readonly objectType = 'githubTokenBasicAuth' as const;
  readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  injectIntoCurlCall(curlArguments: readonly string[]): Promise<readonly string[]> {
    return Promise.resolve(['-u', `x-access-token:${this.token}`, ...curlArguments]);
  }

  isExpired(): boolean | undefined {
    return undefined;
  }
}

// GitHub personal access token scopes to enable
const GITHUB_TOKEN_SCOPES = [
  'repo',
  'workflow',
  'write:packages',
  'delete:packages',
  'gist',
  'notifications',
  'admin:org',
  'admin:repo_hook',
  'admin:org_hook',
  'user',
  'delete_repo',
  'write:discussion',
  'admin:enterprise',
  'read:audit_log',
  'codespace',
  'copilot',
  'write:network_configurations',
  'project',
] as const;

class GithubServiceSession extends BrowserFollowupServiceSession {
  private isLoggedIn = false;

  onResponse(response: Response): void {
    if (this.isLoggedIn) {
      return;
    }

    const request = response.request();
    // Detect login (and github's sudo) by seeing if github allows us to access the new token page.
    if (request.url() != GITHUB_NEW_TOKEN_URL) {
      return;
    }
    if (response.status() != 200) {
      return;
    }
    // Make sure the content returned is actually the correct page, not just the sudo page.
    void response.text().then((text) => {
      if (text.includes('<p id="settings_user_tokens_note">')) {
        this.isLoggedIn = true;
      }
    });
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

    await page.goto(GITHUB_NEW_TOKEN_URL);

    // Add a note for the token
    const noteInput = page.locator('//*[@id="oauth_access_description"]');
    await noteInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await typeLikeHuman(page, noteInput, this.generateAppName());

    // Enable all necessary scopes
    for (const scope of GITHUB_TOKEN_SCOPES) {
      const checkbox = page.locator(`input[name="oauth_access[scopes][]"][value="${scope}"]`);
      if (await checkbox.isVisible()) {
        await checkbox.check();
      }
    }

    // Click the Generate Token button
    // Get me button with type="submit" that's somewhere under a form with id="new_oauth_access".
    const generateButton = page.locator('form#new_oauth_access button[type="submit"]');
    await generateButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await generateButton.click();

    // Wait for the page to load and retrieve the generated token
    const tokenElement = page.locator('//*[@id="new-oauth-token"]');
    await tokenElement.waitFor({ timeout: DEFAULT_TIMEOUT_MS });

    const token = await tokenElement.textContent();
    if (token === null || token === '') {
      throw new LoginFailedError('Failed to extract token from GitHub.');
    }

    await page.close();

    return new AuthorizationBearer(token);
  }
}

export class Github extends Service {
  readonly name = 'github';
  readonly displayName = 'GitHub';
  readonly baseApiUrls = [
    'https://api.github.com/',
    'https://uploads.github.com/',
    GITHUB_GIT_OPERATION_URL_PATTERN,
  ] as const;
  readonly loginUrl = GITHUB_NEW_TOKEN_URL;
  readonly info =
    'https://docs.github.com/en/rest. ' +
    'A personal access token with broad permissions is created during login.';

  readonly credentialCheckCurlArguments = ['https://api.github.com/user'] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
  }

  override adjustCredentials(apiCredentials: ApiCredentials, url: string): ApiCredentials {
    if (!GITHUB_GIT_OPERATION_URL_PATTERN.test(url)) {
      return apiCredentials;
    }
    if (!(apiCredentials instanceof AuthorizationBearer)) {
      throw new UnexpectedGithubCredentialsError();
    }
    return new GithubTokenBasicAuth(apiCredentials.token);
  }

  override getSession(appNamePrefix: string): GithubServiceSession {
    return new GithubServiceSession(this, appNamePrefix);
  }

  protected override parseAccountFromCredentialCheckBody(responseBody: string): string | null {
    // The login is the stable GitHub handle; the e-mail is null unless the
    // user makes it public, so keying on it would be unreliable.
    const data = tryParseJson(responseBody) as { login?: string } | null;
    return data?.login ?? null;
  }
}

export const GITHUB = new Github();
