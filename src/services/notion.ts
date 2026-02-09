/**
 * Notion service implementation.
 *
 * This has some severe limitations:
 *
 * - It requires the UI to be in English.
 * - It only grants access to the private pages that existed at the time of login.
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

    // Annoyingly, Notion's DOM is devoid of IDs,
    // so we have to use broad locators with nth.

    // Integration name
    await page.getByRole('textbox').click();
    await page.getByRole('textbox').fill(generateLatchkeyAppName());
    // Workspace - initially empty
    await page.getByRole('button').filter({ hasText: /^$/ }).click();
    // Just pick the first workspace
    await page.getByRole('menuitem').click();
    // Create integration
    await page.getByRole('button').last().click();
    // Configure integration settings
    await page
      .getByRole('dialog')
      .getByRole('button')
      .nth(0)
      .click({ timeout: DEFAULT_TIMEOUT_MS });
    // Token input
    const tokenTextbox = page.locator('input[type="password"]');
    // We have to save the element handle because the same element's type changes to text after clicking "Show".
    const tokenTextboxElement = (await tokenTextbox.elementHandle())!;
    // Show
    await tokenTextbox
      .locator('..')
      .getByRole('button')
      .nth(1)
      .click({ timeout: DEFAULT_TIMEOUT_MS });

    let token = '';
    // Poll for up to 2 seconds for the token to be revealed
    for (let i = 0; i < 20; i++) {
      token = (await tokenTextboxElement.inputValue()).trim();
      if (token !== '') {
        break;
      }
      await page.waitForTimeout(100);
    }

    if (token === '') {
      throw new LoginFailedError('Failed to extract token from Notion.');
    }

    // Grant access.
    // This part of the flow is too annoying to automate without using the labels...
    await page.getByRole('tab', { name: 'Access' }).click();
    await page.getByRole('button', { name: 'Edit access' }).click();
    await page.getByRole('button', { name: 'Private' }).click();
    await page.getByRole('button', { name: 'Select all' }).click();
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });

    await page.close();

    return new AuthorizationBearer(token);
  }
}

export class Notion implements Service {
  readonly name = 'notion';
  readonly displayName = 'Notion';
  readonly baseApiUrls = ['https://api.notion.com/'] as const;
  readonly loginUrl = NOTION_INTEGRATIONS_URL;
  readonly info =
    'Uses the Notion API (https://developers.notion.com/reference). ' +
    'Include "Notion-Version: 2022-06-28" header in all requests. ' +
    'Access is limited to pages that existed when the integration was created.';

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
