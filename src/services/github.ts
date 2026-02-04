/**
 * GitHub service implementation.
 */

import type { Response, BrowserContext } from 'playwright';
import { ApiCredentialStatus, ApiCredentials, AuthorizationBearer } from '../apiCredentials.js';
import { runCaptured } from '../curl.js';
import { generateLatchkeyAppName, typeLikeHuman } from '../playwrightUtils.js';
import { Service, BrowserFollowupServiceSession, LoginFailedError } from './base.js';

const DEFAULT_TIMEOUT_MS = 8000;

// URL for creating a new personal access token (also used as login URL to trigger sudo)
const GITHUB_NEW_TOKEN_URL = 'https://github.com/settings/tokens/new';

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
    await typeLikeHuman(page, noteInput, generateLatchkeyAppName());

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

export class Github implements Service {
  readonly name = 'github';
  readonly baseApiUrls = ['https://api.github.com/'] as const;
  readonly loginUrl = GITHUB_NEW_TOKEN_URL;

  readonly credentialCheckCurlArguments = ['https://api.github.com/user'] as const;

  getSession(): GithubServiceSession {
    return new GithubServiceSession(this);
  }

  checkApiCredentials(apiCredentials: ApiCredentials): ApiCredentialStatus {
    if (!(apiCredentials instanceof AuthorizationBearer)) {
      return ApiCredentialStatus.Invalid;
    }

    const result = runCaptured(
      [
        '-s',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        ...apiCredentials.asCurlArguments(),
        ...this.credentialCheckCurlArguments,
      ],
      10
    );

    if (result.stdout === '200') {
      return ApiCredentialStatus.Valid;
    }
    return ApiCredentialStatus.Invalid;
  }
}

export const GITHUB = new Github();
