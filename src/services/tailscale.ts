/**
 * Tailscale service implementation.
 *
 * The Tailscale admin API (https://api.tailscale.com/api/v2/) authenticates with
 * an API access token (`tskey-api-...`) that an Owner/Admin creates in the
 * admin console's Keys page. The token's value is revealed exactly once at
 * creation time (like Linear, HuggingFace and OpenRouter), so we sign the user
 * into the admin console, generate a fresh access token on their behalf, and
 * read its value from the one-time reveal dialog.
 *
 * A single API access token grants the full set of actions its owning user may
 * perform: tailnet-wide user management (role changes, approval, suspension,
 * deletion), device management, ACL/policy, DNS, and the minting of further
 * keys (including the auth keys the `tailscale` CLI consumes to bring up
 * nodes). It expires after at most 90 days, after which the user re-runs the
 * browser login to mint a new one -- the token is static and is not refreshable.
 */

import type { Response, BrowserContext } from 'playwright';
import { z } from 'zod';
import { ApiCredentialStatus, ApiCredentials } from '../apiCredentials/base.js';
import { typeLikeHuman } from '../playwrightUtils.js';
import { runCapturedAsync } from '../curl.js';
import {
  Service,
  BrowserFollowupServiceSession,
  FollowupWork,
  LoginFailedError,
  isBrowserClosedError,
  LoginCancelledError,
  type ManualCredentialForm,
} from './core/base.js';

const DEFAULT_TIMEOUT_MS = 30000;

// The Tailscale admin REST API.
const TAILSCALE_API_BASE_URL = 'https://api.tailscale.com/';

// `latchkey auth browser` opens this; it redirects to the SSO sign-in page and
// then back to the admin console once the user is signed in.
const TAILSCALE_LOGIN_URL = 'https://login.tailscale.com/admin';

// The admin console's Keys page, where API access tokens are generated.
const TAILSCALE_KEYS_URL = 'https://console.tailscale.com/admin/settings/keys';

// The admin console host; a document response served from it means the user is
// signed in (the sign-in flow itself is served from login.tailscale.com and the
// SSO provider).
const TAILSCALE_CONSOLE_HOST = 'console.tailscale.com';

// GET /tailnet/{tailnet}/settings is a cheap read that answers 200 for any
// valid token with the access the API access token carries (full user powers).
// It doubles as the credential check once the tailnet is known.
const TAILSCALE_SETTINGS_URL_PREFIX = 'https://api.tailscale.com/api/v2/tailnet/';

// API access tokens are prefixed `tskey-api-`; the reveal dialog renders the
// value as plain text (not inside an input).
const TAILSCALE_TOKEN_PATTERN = /tskey-api-[A-Za-z0-9-]+/;

/**
 * Credentials for the Tailscale API: a static API access token plus the tailnet
 * it belongs to. The tailnet is part of nearly every useful Tailscale API path
 * and the API exposes no tailnet-independent way to validate a token, so the
 * connector captures it at mint time (it is shown in the admin console's
 * navigation) and stores it alongside the token.
 */
export const TailscaleCredentialsSchema = z.object({
  objectType: z.literal('tailscale'),
  token: z.string(),
  tailnet: z.string(),
});

export type TailscaleCredentialsData = z.infer<typeof TailscaleCredentialsSchema>;

export class TailscaleCredentials implements ApiCredentials {
  readonly objectType = 'tailscale' as const;
  readonly token: string;
  readonly tailnet: string;

  constructor(token: string, tailnet: string) {
    this.token = token;
    this.tailnet = tailnet;
  }

  injectIntoCurlCall(curlArguments: readonly string[]): Promise<readonly string[]> {
    return Promise.resolve(['-H', `Authorization: Bearer ${this.token}`, ...curlArguments]);
  }

  // The token is static and its expiry date is not exposed in a parseable form
  // at creation time; validity is determined by the live credential check
  // rather than a local clock.
  isExpired(): boolean | undefined {
    return undefined;
  }

  toJSON(): TailscaleCredentialsData {
    return {
      objectType: this.objectType,
      token: this.token,
      tailnet: this.tailnet,
    };
  }

  static fromJSON(data: TailscaleCredentialsData): TailscaleCredentials {
    return new TailscaleCredentials(data.token, data.tailnet);
  }
}

class TailscaleServiceSession extends BrowserFollowupServiceSession {
  protected readonly followupWork = FollowupWork.CreateApiToken;
  override readonly manualCredentialForm: ManualCredentialForm = {
    instructions:
      `To finish by hand, open ${TAILSCALE_KEYS_URL} in the other tab of this window and ` +
      'generate an API access token. The tailnet name is shown at the top of the admin ' +
      'console; almost every Tailscale API path needs it, which is why it is asked for here.',
    fields: [
      {
        name: 'token',
        label: 'API access token',
        hint: 'Starts with "tskey-api-".',
      },
      {
        name: 'tailnet',
        label: 'Tailnet',
        hint: 'For example "example.com" or "tail1234.ts.net".',
      },
    ],
    buildCredentials: (values) =>
      new TailscaleCredentials(values.get('token'), values.get('tailnet')),
  };
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
    if (url.hostname !== TAILSCALE_CONSOLE_HOST) {
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

    try {
      await page.goto(TAILSCALE_KEYS_URL, { waitUntil: 'domcontentloaded' });

      // The tailnet name is the first link in the admin shell's navigation; it
      // is part of every useful API call, so read it before the mint dialog
      // covers the page.
      const tailnetLink = page.locator('#app-root a').first();
      await tailnetLink.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
      const tailnet = (await tailnetLink.innerText()).trim();
      if (!tailnet) {
        throw new LoginFailedError('Failed to read the Tailscale tailnet name.');
      }

      // Open the "Generate API access token" dialog. There are two "Generate..."
      // buttons on the Keys page (auth key and access token); the access-token
      // one is labelled with a trailing ellipsis, which distinguishes it from
      // the dialog's submit button.
      const openButton = page.getByRole('button', { name: 'Generate access token\u2026' });
      await openButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
      await openButton.click();

      const mintDialog = page.getByRole('dialog', { name: 'Generate API access token' });
      await mintDialog.waitFor({ timeout: DEFAULT_TIMEOUT_MS });

      // The description input is the first input in the dialog (the "Add an
      // optional description" text above it is a label, not a placeholder).
      const descriptionInput = mintDialog.locator('input').first();
      await descriptionInput.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
      await typeLikeHuman(page, descriptionInput, this.generateAppName());

      // Expiration defaults to 90 days; leave it as-is.
      const generateButton = mintDialog.getByRole('button', {
        name: 'Generate access token',
        exact: true,
      });
      await generateButton.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
      await generateButton.click();

      // The same dialog is then reused to reveal the new token exactly once,
      // as plain text.
      const revealDialog = page.getByRole('dialog', { name: 'Generated new key' });
      await revealDialog.waitFor({ timeout: DEFAULT_TIMEOUT_MS });
      const revealText = await revealDialog.innerText();
      const match = TAILSCALE_TOKEN_PATTERN.exec(revealText);
      if (!match) {
        throw new LoginFailedError('Failed to extract the API access token from Tailscale.');
      }

      await page.close();
      return new TailscaleCredentials(match[0], tailnet);
    } catch (error: unknown) {
      if (error instanceof Error && isBrowserClosedError(error)) {
        throw new LoginCancelledError();
      }
      throw error;
    }
  }
}

export class Tailscale extends Service {
  readonly name = 'tailscale';
  readonly displayName = 'Tailscale';
  readonly baseApiUrls = [TAILSCALE_API_BASE_URL] as const;
  readonly loginUrl = TAILSCALE_LOGIN_URL;
  readonly info =
    'Tailscale admin API for tailnet-wide management (users, devices, policy, keys). ' +
    'Docs: https://tailscale.com/docs/reference/tailscale-api and interactive ' +
    'https://tailscale.com/api. A browser login mints an API access token (tskey-api) ' +
    'that carries the full set of actions its owning user may perform and expires ' +
    'after at most 90 days; re-run the login to mint a new one. Most endpoints are ' +
    'scoped to a tailnet (e.g. /api/v2/tailnet/{tailnet}/users); the stored credential ' +
    'remembers the tailnet seen at login.';

  // The credential check needs the tailnet, which the static
  // credentialCheckCurlArguments cannot carry, so checkApiCredentials is
  // overridden below and this value is unused (mirrors RegisteredService).
  readonly credentialCheckCurlArguments = [] as const;

  override async checkApiCredentials(apiCredentials: ApiCredentials): Promise<ApiCredentialStatus> {
    // The tailnet is needed to validate a token and is only carried by the
    // browser-minted credential. A manually-set credential (e.g. `auth set -H
    // "Authorization: Bearer ..."`) has no tailnet to build the check URL
    // from, so its status cannot be determined locally; `latchkey curl` still
    // injects it normally.
    if (!(apiCredentials instanceof TailscaleCredentials)) {
      return ApiCredentialStatus.Unknown;
    }

    const checkUrl = `${TAILSCALE_SETTINGS_URL_PREFIX}${encodeURIComponent(apiCredentials.tailnet)}/settings`;
    const result = await runCapturedAsync(
      [
        '-s',
        '-w',
        '\n%{http_code}',
        '-H',
        `Authorization: Bearer ${apiCredentials.token}`,
        checkUrl,
      ],
      10
    );

    // The `-w '\n%{http_code}'` above appends the status code as the final line.
    const statusCode = result.stdout.slice(result.stdout.lastIndexOf('\n') + 1).trim();
    return statusCode === '200' ? ApiCredentialStatus.Valid : ApiCredentialStatus.Invalid;
  }

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
  }

  // The API access token is owned by the user who minted it but exposes no
  // queryable "current user" endpoint; the tailnet it belongs to is the most
  // meaningful account identifier available without an extra request.
  override getAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    if (apiCredentials instanceof TailscaleCredentials) {
      return Promise.resolve(apiCredentials.tailnet);
    }
    return Promise.resolve(null);
  }

  override getSession(appNamePrefix: string): TailscaleServiceSession {
    return new TailscaleServiceSession(this, appNamePrefix);
  }
}

export const TAILSCALE = new Tailscale();
