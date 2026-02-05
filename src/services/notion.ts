/**
 * Notion service implementation.
 */

import type { Response, BrowserContext } from 'playwright';
import { ApiCredentialStatus, ApiCredentials, AuthorizationBearer } from '../apiCredentials.js';
import { runCaptured } from '../curl.js';
import { generateLatchkeyAppName } from '../playwrightUtils.js';
import { Service, BrowserFollowupServiceSession, LoginFailedError } from './base.js';

const DEFAULT_TIMEOUT_MS = 8000;

const NOTION_INTEGRATIONS_URL = 'https://www.notion.so/profile/integrations/form/new-integration';

class NotionServiceSession extends BrowserFollowupServiceSession {
  private isLoggedIn = false;

  onResponse(response: Response): void {
    if (this.isLoggedIn) {
      return;
    }
    if (response.request().headers()['x-notion-active-user-header']) {
      this.isLoggedIn = true;
    }
  }

  protected isLoginComplete(): boolean {
    return this.isLoggedIn;
  }

  protected async performBrowserFollowup(context: BrowserContext): Promise<ApiCredentials | null> {
    const page = context.pages()[0];
    if (!page) {
      throw new LoginFailedError('No page available in browser context.');
    }

    await page.goto(NOTION_INTEGRATIONS_URL);

    // Integration name
    await page.getByRole('textbox').click();
    await page.getByRole('textbox').fill(generateLatchkeyAppName());
    // Workspace
    await page.getByRole('button').filter({ hasText: /^$/ }).click();
    await page.getByRole('menuitem').click();
    // Create integration
    await page.getByRole('button').nth(1).click();
    // Configure integration settings
    await page.getByRole('dialog').getByRole('button').click({ timeout: DEFAULT_TIMEOUT_MS });
    await page
      .getByRole('button', { name: 'Configure integration settings' })
      .click({ timeout: DEFAULT_TIMEOUT_MS });
    // Show
    await page
      .locator('input[type="password"]')
      .locator('..')
      .getByRole('button')
      .nth(1)
      .click({ timeout: DEFAULT_TIMEOUT_MS });

    const tokenTextbox = page.locator('input[type="password"]');
    await tokenTextbox.waitFor({ timeout: DEFAULT_TIMEOUT_MS });

    const token = await tokenTextbox.inputValue();
    if (token === '') {
      throw new LoginFailedError('Failed to extract token from Notion.');
    }

    await page.close();

    return new AuthorizationBearer(token);
  }
}

export class Notion implements Service {
  readonly name = 'notion';
  readonly baseApiUrls = ['https://api.notion.com/'] as const;
  readonly loginUrl = NOTION_INTEGRATIONS_URL;

  readonly credentialCheckCurlArguments = [
    '-H',
    'Notion-Version: 2022-06-28',
    'https://api.notion.com/v1/users/me',
  ] as const;

  getSession(): NotionServiceSession {
    return new NotionServiceSession(this);
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

export const NOTION = new Notion();
