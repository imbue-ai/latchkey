/**
 * Dropbox service implementation.
 */

import { randomUUID } from 'node:crypto';
import type { Response, BrowserContext } from 'playwright';
import { ApiCredentialStatus, ApiCredentials, AuthorizationBearer } from '../apiCredentials.js';
import { runCaptured } from '../curl.js';
import { typeLikeHuman } from '../playwrightUtils.js';
import { Service, BrowserFollowupServiceSession, LoginFailedError } from './base.js';

const DEFAULT_TIMEOUT_MS = 8000;

class DropboxServiceSession extends BrowserFollowupServiceSession {
  private isLoggedIn = false;

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

    this.isLoggedIn = true;
  }

  protected isHeadfulLoginComplete(): boolean {
    return this.isLoggedIn;
  }

  protected async performBrowserFollowup(context: BrowserContext): Promise<ApiCredentials | null> {
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

    const appName = `Latchkey-${randomUUID().slice(0, 8)}`;
    const appNameInput = page.locator('input#app-name');
    await appNameInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await typeLikeHuman(page, appNameInput, appName);

    const createButton = page.getByRole('button', { name: 'Create app' });
    await createButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await createButton.click();

    await page.waitForURL(/https:\/\/www\.dropbox\.com\/developers\/apps\/info\//, {
      timeout: DEFAULT_TIMEOUT_MS,
    });

    // Configure permissions before generating token
    const permissionsTab = page.locator('a.c-tabs__label[data-hash="permissions"]');
    await permissionsTab.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await permissionsTab.click();

    // Enable all necessary permissions
    const permissionIds = [
      'files.metadata.write',
      'files.content.write',
      'files.content.read',
      'sharing.write',
      'file_requests.write',
      'contacts.write',
    ];

    for (const permissionId of permissionIds) {
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

    // Return to Settings tab to generate token
    const settingsTab = page.locator('a.c-tabs__label[data-hash="settings"]');
    await settingsTab.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await settingsTab.click();

    const generateButton = page.locator('input#generate-token-button');
    await generateButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await generateButton.click();

    const tokenInput = page.locator('input#generated-token[data-token]');
    await tokenInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });

    const token = await tokenInput.getAttribute('data-token');
    if (token === null || token === '') {
      throw new LoginFailedError('Failed to extract token from Dropbox.');
    }

    await page.close();

    return new AuthorizationBearer(token);
  }
}

export class Dropbox implements Service {
  readonly name = 'dropbox';
  readonly baseApiUrls = [
    'https://api.dropboxapi.com/',
    'https://content.dropboxapi.com/',
    'https://notify.dropboxapi.com/',
  ] as const;
  readonly loginUrl = 'https://www.dropbox.com/login';

  readonly credentialCheckCurlArguments = [
    '-X',
    'POST',
    'https://api.dropboxapi.com/2/users/get_current_account',
  ] as const;

  getSession(): DropboxServiceSession {
    return new DropboxServiceSession(this);
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

export const DROPBOX = new Dropbox();
