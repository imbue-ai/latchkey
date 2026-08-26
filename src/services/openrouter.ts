/**
 * OpenRouter service implementation.
 *
 * OpenRouter issues personal API keys from the dashboard, and a key's value is
 * revealed exactly once at creation time (like Linear). We sign the user into
 * openrouter.ai, create a fresh API key on their behalf, and read its value from
 * the one-time reveal dialog.
 *
 * The OpenRouter API is OpenAI-compatible: every request authenticates with a
 * single `Authorization: Bearer sk-or-v1-...` header, so we store an
 * AuthorizationBearer credential and let it inject that header into every
 * matching request.
 */

import type { Response, BrowserContext } from 'playwright';
import { ApiCredentials, AuthorizationBearer } from '../apiCredentials/base.js';
import { typeLikeHuman } from '../playwrightUtils.js';
import {
  Service,
  BrowserFollowupServiceSession,
  FollowupWork,
  LoginFailedError,
} from './core/base.js';

const DEFAULT_TIMEOUT_MS = 12000;

// The OpenRouter REST API (OpenAI-compatible), served under /api/v1.
const OPENROUTER_API_BASE_URL = 'https://openrouter.ai/api/v1/';

const OPENROUTER_LOGIN_URL = 'https://openrouter.ai/sign-in';

// The dashboard's API-keys page. It redirects to the workspace-scoped keys page
// (/workspaces/<workspace>/keys); a plain goto follows that redirect.
const OPENROUTER_KEYS_URL = 'https://openrouter.ai/keys';

// GET /api/v1/key returns the calling key's metadata (label, usage, limit) and
// answers 200 for any valid key, so it doubles as the credential check.
const OPENROUTER_KEY_INFO_URL = 'https://openrouter.ai/api/v1/key';

// Dashboard host, and the path prefixes served before the user is signed in. A
// dashboard document response on any *other* path only happens once login has
// succeeded, so we use it as the login-complete signal (works the same whether
// the user signs in with a password or an SSO provider, since the final redirect
// target is always a dashboard page). A new device also gets an email one-time
// code under /sign-in, which this pattern keeps waiting through.
const OPENROUTER_HOST = 'openrouter.ai';
const OPENROUTER_PRE_LOGIN_PATH_PATTERN = /^\/(sign-in|sign-up|signin|signup|sso|oauth|auth)/i;

// OpenRouter keys are prefixed `sk-or-v1-`; the reveal dialog renders the value
// as plain text (not inside an input), so we extract it from the dialog text.
const OPENROUTER_KEY_PATTERN = /sk-or-v1-[A-Za-z0-9-]+/;

class OpenrouterServiceSession extends BrowserFollowupServiceSession {
  protected readonly followupWork = FollowupWork.CreateApiToken;
  private isLoggedIn = false;

  onResponse(response: Response): void {
    if (this.isLoggedIn) {
      return;
    }
    if (response.request().resourceType() !== 'document') {
      return;
    }
    let url: URL;
    try {
      url = new URL(response.url());
    } catch {
      return;
    }
    if (url.hostname !== OPENROUTER_HOST) {
      return;
    }
    if (OPENROUTER_PRE_LOGIN_PATH_PATTERN.test(url.pathname)) {
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

    await page.goto(OPENROUTER_KEYS_URL, { waitUntil: 'domcontentloaded' });

    // Open the "Create API Key" dialog. The keys page is a heavy client-rendered
    // table, so the New Key button can sit in the DOM before React attaches its
    // click handler; a too-early click is a no-op. Click until the dialog's name
    // field actually appears (guarding against re-clicking an already-open
    // dialog, whose overlay would swallow the click).
    const newKeyButton = page.getByRole('button', { name: 'New Key' });
    await newKeyButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    const nameInput = page.locator('input#name');
    for (let attempt = 0; attempt < 5; attempt++) {
      const alreadyOpen = await nameInput.isVisible().catch(() => false);
      if (!alreadyOpen) {
        await newKeyButton.click().catch(() => undefined);
      }
      try {
        await nameInput.waitFor({ timeout: 3000 });
        break;
      } catch {
        if (attempt === 4) {
          throw new LoginFailedError('OpenRouter "New Key" dialog did not open.');
        }
      }
    }

    // Give the key a recognizable name so the user can find and revoke it.
    const keyName = this.generateAppName();
    await typeLikeHuman(page, nameInput, keyName);

    // Scope to the named dialog: a bare [role="dialog"] is ambiguous on this page
    // (it also matches a hidden email-verification dialog and a password-manager
    // modal), which makes every locator under it strict-mode-fail. The dialog keeps
    // this title through the reveal step. Its Create button stays disabled until the
    // name is non-empty.
    const dialog = page.getByRole('dialog', { name: 'Create API Key' });
    const createButton = dialog.getByRole('button', { name: 'Create', exact: true });
    await createButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await createButton.click();

    // The same dialog then reveals the new key exactly once, as plain text.
    await dialog.getByText('Your new key:').waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    const dialogText = await dialog.innerText();
    const match = OPENROUTER_KEY_PATTERN.exec(dialogText);
    if (!match) {
      throw new LoginFailedError('Failed to extract API key from OpenRouter.');
    }

    await page.close();
    return new AuthorizationBearer(match[0]);
  }
}

export class Openrouter extends Service {
  readonly name = 'openrouter';
  readonly displayName = 'OpenRouter';
  readonly baseApiUrls = [OPENROUTER_API_BASE_URL] as const;
  readonly loginUrl = OPENROUTER_LOGIN_URL;
  readonly info =
    'OpenRouter unified LLM API (OpenAI-compatible). Docs: https://openrouter.ai/docs/llms.txt';

  // GET /api/v1/key returns 200 for any valid key; the stored bearer header is
  // added by the credential before the request is sent.
  readonly credentialCheckCurlArguments = [OPENROUTER_KEY_INFO_URL] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
  }

  // An OpenRouter API key has no queryable user-identity endpoint, so the account
  // is left as the default rather than guessed.
  override getAccount(_apiCredentials: ApiCredentials): Promise<string | null> {
    return Promise.resolve(null);
  }

  override getSession(appNamePrefix: string): OpenrouterServiceSession {
    return new OpenrouterServiceSession(this, appNamePrefix);
  }
}

export const OPENROUTER = new Openrouter();
