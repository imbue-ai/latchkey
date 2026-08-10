/**
 * Hugging Face service implementation.
 *
 * Hugging Face issues personal User Access Tokens from the account settings,
 * and a token's value is revealed exactly once at creation time (like Linear).
 * We sign the user into huggingface.co, create a fresh read-only token on their
 * behalf, and read its value from the one-time reveal dialog.
 *
 * Requests to the Hub API and the Inference router authenticate with a single
 * `Authorization: Bearer hf_...` header, so we store an AuthorizationBearer
 * credential and let it inject that header into every matching request.
 */

import type { Response, BrowserContext } from 'playwright';
import { ApiCredentials, AuthorizationBearer } from '../apiCredentials/base.js';
import { fetchAccountFromEndpoint, tryParseJson } from '../apiCredentials/account.js';
import { typeLikeHuman } from '../playwrightUtils.js';
import {
  Service,
  BrowserFollowupServiceSession,
  FollowupWork,
  LoginFailedError,
} from './core/base.js';

const DEFAULT_TIMEOUT_MS = 8000;

// Hub API + Inference router. Hub model/dataset downloads and the whoami check
// live under huggingface.co; hosted inference goes through the router.
const HF_HUB_BASE_URL = 'https://huggingface.co/';
const HF_ROUTER_BASE_URL = 'https://router.huggingface.co/';

const HF_LOGIN_URL = 'https://huggingface.co/login';

// Navigating here opens the "Create new Access Token" form preset to a
// read-only token; the value is shown once in a dialog after creation.
const HF_NEW_READ_TOKEN_URL = 'https://huggingface.co/settings/tokens/new?tokenType=read';

// Endpoint that returns the signed-in identity; also used as the credential check.
const HF_WHOAMI_URL = 'https://huggingface.co/api/whoami-v2';

// Hub host, and the path prefixes served before the user is signed in. A
// document response to the hub host on any *other* path only happens once login
// has succeeded, so we use it as the login-complete signal (works the same for
// a password or SSO sign-in, since the final redirect target is a hub page).
const HF_HUB_HOST = 'huggingface.co';
const HF_PRE_LOGIN_PATH_PATTERN = /^\/(login|join|signup|oauth|sso|auth|logout)/i;

class HuggingfaceServiceSession extends BrowserFollowupServiceSession {
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
    if (url.hostname !== HF_HUB_HOST) {
      return;
    }
    if (HF_PRE_LOGIN_PATH_PATTERN.test(url.pathname)) {
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

    await page.goto(HF_NEW_READ_TOKEN_URL);

    // Give the token a recognizable name so the user can find and revoke it.
    const tokenName = this.generateAppName();
    const nameInput = page.locator('input[name="displayName"]');
    await nameInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await typeLikeHuman(page, nameInput, tokenName);

    // Locale-independent: the create button is the submit inside the token-name form.
    const createButton = page.locator('form:has(input[name="displayName"]) button[type="submit"]');
    await createButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    await createButton.click();

    // The new token is revealed exactly once, inside the success dialog. Its
    // value sits in a text input; Hugging Face tokens are prefixed `hf_`.
    const tokenInput = page.locator('dialog input').first();
    await tokenInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
    const token = (await tokenInput.inputValue()).trim();
    if (token === '' || !token.startsWith('hf_')) {
      throw new LoginFailedError('Failed to extract access token from Hugging Face.');
    }

    await page.close();
    return new AuthorizationBearer(token);
  }
}

export class Huggingface extends Service {
  readonly name = 'huggingface';
  readonly displayName = 'Hugging Face';
  readonly baseApiUrls = [HF_HUB_BASE_URL, HF_ROUTER_BASE_URL] as const;
  readonly loginUrl = HF_LOGIN_URL;
  // Signing in mints a read-only User Access Token. To mint and run hosted
  // inference, request the `huggingface-api` scope with `huggingface-inference`
  // (add `huggingface-read` to list/download models & datasets; `huggingface-write`
  // covers creating repos and uploading).
  readonly info =
    'Hugging Face Hub + Inference. Signing in mints a read-only token. To mint and run ' +
    'hosted inference, request the huggingface-api scope with huggingface-inference (add ' +
    'huggingface-read to download models/datasets). Docs: https://huggingface.co/docs/hub/en/api';

  // whoami-v2 returns 200 for any valid token; the stored bearer header is
  // added by the credential before the request is sent.
  readonly credentialCheckCurlArguments = [HF_WHOAMI_URL] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
  }

  override getAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    return fetchAccountFromEndpoint(
      apiCredentials,
      this.credentialCheckCurlArguments,
      (responseBody) => {
        const data = tryParseJson(responseBody) as { name?: string; email?: string } | null;
        return data?.name ?? data?.email ?? null;
      }
    );
  }

  override getSession(appNamePrefix: string): HuggingfaceServiceSession {
    return new HuggingfaceServiceSession(this, appNamePrefix);
  }
}

export const HUGGINGFACE = new Huggingface();
