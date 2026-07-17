/**
 * Todoist service implementation.
 */

import type { Response, BrowserContext } from 'playwright';
import { ApiCredentials, AuthorizationBearer } from '../apiCredentials/base.js';
import {
  Service,
  BrowserFollowupServiceSession,
  LoginFailedError,
  tryParseJson,
} from './core/base.js';

const DEFAULT_TIMEOUT_MS = 8000;

// The Developer settings page exposes the user's personal API token. It also
// doubles as the login URL: when visited while logged out, Todoist redirects to
// the sign-in page; once the user authenticates, they land back here with the
// token visible.
const TODOIST_DEVELOPER_SETTINGS_URL =
  'https://app.todoist.com/app/settings/integrations/developer';

class TodoistServiceSession extends BrowserFollowupServiceSession {
  private isLoggedIn = false;

  onResponse(response: Response): void {
    if (this.isLoggedIn) {
      return;
    }

    // Todoist's web app is a SPA that continuously syncs once the user is signed
    // in. Detect login by observing a successful, authenticated API call (mirrors
    // the Dropbox session, which watches for an authenticated request).
    const url = response.request().url();
    if (
      !url.startsWith('https://app.todoist.com/api/') &&
      !url.startsWith('https://api.todoist.com/')
    ) {
      return;
    }
    if (response.status() !== 200) {
      return;
    }

    this.isLoggedIn = true;
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

    await page.goto(TODOIST_DEVELOPER_SETTINGS_URL);

    // The personal API token is shown in a read-only input on the Developer
    // settings page. Read it directly from the element value (never the
    // clipboard), the same way other services scrape generated tokens.
    const tokenInput = page.locator('input[readonly]').first();
    await tokenInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });

    const token = (await tokenInput.inputValue()).trim();
    if (token === '') {
      throw new LoginFailedError('Failed to extract token from Todoist.');
    }

    await page.close();

    return new AuthorizationBearer(token);
  }
}

export class Todoist extends Service {
  readonly name = 'todoist';
  readonly displayName = 'Todoist';
  readonly baseApiUrls = ['https://api.todoist.com/'] as const;
  readonly loginUrl = TODOIST_DEVELOPER_SETTINGS_URL;
  readonly info =
    'https://developer.todoist.com/api/v1. ' +
    'The personal API token is read from Settings → Integrations → Developer during login.';

  // /user both validates the token and identifies the account.
  readonly credentialCheckCurlArguments = ['https://api.todoist.com/api/v1/user'] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
  }

  protected override parseAccountFromCredentialCheckBody(responseBody: string): string | null {
    const data = tryParseJson(responseBody) as {
      email?: string;
      full_name?: string;
      id?: string;
    } | null;
    return data?.email ?? data?.full_name ?? data?.id ?? null;
  }

  override getSession(appNamePrefix: string): TodoistServiceSession {
    return new TodoistServiceSession(this, appNamePrefix);
  }
}

export const TODOIST = new Todoist();
