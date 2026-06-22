/**
 * Greenhouse service implementation.
 *
 * The Greenhouse Harvest API authenticates with HTTP Basic auth where the API
 * key is the username and the password is blank, i.e.
 * `Authorization: Basic base64("<key>:")`. The key is long-lived and is created
 * by an admin under Configure -> Dev Center -> API Credential Management, where
 * the accessible endpoints are also chosen per key. Only the public Harvest API
 * is used here.
 *
 * Two ways to obtain a key are supported:
 *   - `latchkey auth set-nocurl greenhouse <api-key>` stores a key created by
 *     hand (see `getCredentialsNoCurl`).
 *   - `latchkey auth browser greenhouse` logs the user into Greenhouse, then
 *     drives the Dev Center to create a fresh Harvest key, scrapes the one-time
 *     key, and stores it (see `GreenhouseServiceSession` below).
 *
 * ============================================================================
 *  BEST-EFFORT SELECTORS — MUST BE VERIFIED AGAINST THE LIVE GREENHOUSE UI
 * ============================================================================
 * The Dev Center flow below was written WITHOUT access to a live Greenhouse
 * org, so every navigation step, form field, and scrape target is a
 * best-effort guess based on Greenhouse's documented "Create a Harvest API
 * key" flow. The text/role-based locators are deliberately loose so they stand
 * a better chance of matching, but they have NOT been confirmed end-to-end.
 *
 * Before relying on this flow, re-record it against the real UI and tighten the
 * selectors:
 *   - `npx tsx scripts/codegen.ts greenhouse https://app.greenhouse.io/`
 *     (records clicks + requests and emits selector suggestions), and/or
 *   - `npx tsx scripts/recordBrowserSession.ts greenhouse`
 *     (captures the request/response stream of a real login), then
 *   - update the selectors here and follow docs/development.md ("Codegen").
 * In particular, confirm: the login-detection signal in `onResponse`, the
 * Configure -> Dev Center -> API Credential Management navigation, the API-type
 * /partner/description fields, the order in which the one-time key is revealed
 * versus the permission-selection step, and the permission control names.
 */

import type { Response, BrowserContext, Page, Locator } from 'playwright';
import { ApiCredentials, AuthorizationBare } from '../apiCredentials/base.js';
import { typeLikeHuman } from '../playwrightUtils.js';
import {
  NoCurlCredentialsNotSupportedError,
  Service,
  BrowserFollowupServiceSession,
  LoginFailedError,
} from './core/base.js';

// Generous default for waits on elements we expect to exist.
const DEFAULT_TIMEOUT_MS = 8000;
// Shorter timeout for probing optional/alternative locators where a miss just
// means "try the next strategy" rather than "fail the flow".
const PROBE_TIMEOUT_MS = 3000;

// A note explaining that the Dev Center selectors are best-effort, reused in the
// error messages so users hitting a selector miss know what to do.
const SELECTOR_CAVEAT =
  'The Greenhouse Dev Center selectors are best-effort and may need to be ' +
  're-recorded against the live UI (see scripts/codegen.ts and docs/development.md).';

/**
 * Build the Harvest Basic-auth credential from a raw API key.
 *
 * Harvest uses Basic auth with the key as the username and a blank password,
 * i.e. `Authorization: Basic base64("<key>:")`. Building the header here keeps
 * the no-curl and browser flows consistent and saves the user from remembering
 * the trailing colon.
 */
function harvestBasicAuth(apiKey: string): AuthorizationBare {
  const basicAuth = Buffer.from(`${apiKey}:`).toString('base64');
  return new AuthorizationBare(`Basic ${basicAuth}`);
}

/**
 * Click the first of several candidate locators that becomes visible.
 *
 * The candidates are tried in order; each is given its own timeout. If none
 * match, a clear `LoginFailedError` is thrown naming what we were looking for.
 */
async function clickAny(
  candidates: readonly Locator[],
  description: string,
  timeoutMs: number
): Promise<void> {
  let lastMessage = '';
  for (const candidate of candidates) {
    const target = candidate.first();
    try {
      await target.waitFor({ state: 'visible', timeout: timeoutMs });
      await target.click();
      return;
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : '';
    }
  }
  throw new LoginFailedError(
    `Could not find ${description} in Greenhouse. ${SELECTOR_CAVEAT}` +
      (lastMessage === '' ? '' : ` (last error: ${lastMessage})`)
  );
}

/**
 * Return the trimmed value of the first candidate locator that resolves to a
 * non-empty string, reading either an input's value or its text content.
 * Returns null if none yield a value.
 */
async function readFirstValue(
  candidates: readonly Locator[],
  timeoutMs: number
): Promise<string | null> {
  for (const candidate of candidates) {
    const target = candidate.first();
    try {
      await target.waitFor({ state: 'visible', timeout: timeoutMs });
    } catch {
      continue;
    }
    // Prefer the value of an <input>/<textarea>; fall back to text content for
    // keys rendered into a <code>/<span> with a copy button.
    let value: string | null = null;
    try {
      value = await target.inputValue();
    } catch {
      value = await target.textContent();
    }
    if (value !== null && value.trim() !== '') {
      return value.trim();
    }
  }
  return null;
}

class GreenhouseServiceSession extends BrowserFollowupServiceSession {
  private isLoggedIn = false;

  onResponse(response: Response): void {
    if (this.isLoggedIn) {
      return;
    }

    const request = response.request();
    const url = request.url();
    if (!url.startsWith('https://app.greenhouse.io/')) {
      return;
    }

    // Require a 2XX response so an expired/invalid session doesn't count.
    const status = response.status();
    if (status < 200 || status >= 300) {
      return;
    }

    // Only treat full-page navigations as a login signal; XHR/fetch traffic is
    // too noisy to rely on. A successful document load for any app page that is
    // not part of the authentication flow means the user is signed in.
    if (request.resourceType() !== 'document') {
      return;
    }

    let path: string;
    try {
      path = new URL(url).pathname.toLowerCase();
    } catch {
      return;
    }

    // Authentication pages (sign-in, SSO/SAML, MFA, password reset) must not be
    // mistaken for a logged-in landing page.
    const AUTH_PATH_MARKERS = [
      'sign_in',
      'sign-in',
      'login',
      'logout',
      'sessions',
      'password',
      'sso',
      'saml',
      'oauth',
      'two_factor',
      'mfa',
    ];
    if (AUTH_PATH_MARKERS.some((marker) => path.includes(marker))) {
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

    await this.navigateToApiCredentialManagement(page);

    // Open the "Create New API Key" dialog.
    await clickAny(
      [
        page.getByRole('link', { name: /create new api key/i }),
        page.getByRole('button', { name: /create new api key/i }),
        page.getByText(/create new api key/i),
      ],
      'the "Create New API Key" button',
      DEFAULT_TIMEOUT_MS
    );

    // API Type must be "Harvest" (the public API this service targets).
    await this.selectApiType(page);

    // Partner is a required field; pick an unlisted/other vendor so the dialog
    // validates. The exact option text varies between orgs, so this is loose.
    await this.selectPartner(page);

    // Give the key a generated, unique name/description.
    const keyName = this.generateAppName();
    await this.fillDescription(page, keyName);

    // Create the key. In the live UI the "Manage Permissions" button both
    // creates the key and reveals it once before the permission step.
    await clickAny(
      [
        page.getByRole('button', { name: /manage permissions|create api key|create key/i }),
        page.getByRole('link', { name: /manage permissions/i }),
        page.getByRole('button', { name: /^create$/i }),
      ],
      'the "Manage Permissions" / create button',
      DEFAULT_TIMEOUT_MS
    );

    // Scrape the one-time key. Harvest keys have no fixed prefix, so we read the
    // value out of the key field rather than matching on its content.
    const apiKey = await readFirstValue(
      [
        page.locator('input[readonly][value], input#api_key, input[name*="api_key" i]'),
        page.getByRole('textbox', { name: /api key/i }),
        page.locator('[data-api-key], code, pre'),
      ],
      DEFAULT_TIMEOUT_MS
    );
    if (apiKey === null) {
      throw new LoginFailedError(
        `Failed to read the newly created Greenhouse Harvest API key. ${SELECTOR_CAVEAT}`
      );
    }

    // Acknowledge that the key has been stored; the live UI gates the next step
    // (permission selection) behind this confirmation. Best-effort: a missing
    // checkbox is not fatal.
    await this.confirmKeyStored(page);

    // Select endpoint permissions. The credential check uses GET /v1/users, and
    // the broader integration also reads candidates, so those reads must be
    // enabled at a minimum; enabling everything is acceptable.
    await this.selectPermissions(page);

    // Persist the permission selection.
    await clickAny(
      [
        page.getByRole('button', { name: /save|update permissions|update api key/i }),
        page.getByRole('link', { name: /save|update permissions/i }),
      ],
      'the "Save" / "Update Permissions" button',
      DEFAULT_TIMEOUT_MS
    );

    await page.close();

    return harvestBasicAuth(apiKey);
  }

  /**
   * Navigate Configure -> Dev Center -> API Credential Management.
   *
   * Done via clicks rather than a direct URL because Greenhouse exposes no
   * stable public URL for the Dev Center pages.
   */
  private async navigateToApiCredentialManagement(page: Page): Promise<void> {
    // Configure (the gear/admin entry in the top navigation).
    await clickAny(
      [
        page.getByRole('link', { name: /^configure$/i }),
        page.getByRole('button', { name: /configure/i }),
        page.locator('a[href="/configure"], a[href*="/configure"]'),
      ],
      'the "Configure" navigation entry',
      DEFAULT_TIMEOUT_MS
    );

    // Dev Center (in the Configure sidebar).
    await clickAny(
      [page.getByRole('link', { name: /dev center/i }), page.getByText(/dev center/i)],
      'the "Dev Center" link',
      DEFAULT_TIMEOUT_MS
    );

    // API Credential Management.
    await clickAny(
      [
        page.getByRole('link', { name: /api credential management/i }),
        page.getByText(/api credential management/i),
      ],
      'the "API Credential Management" link',
      DEFAULT_TIMEOUT_MS
    );
  }

  /** Best-effort selection of the "Harvest" API type. */
  private async selectApiType(page: Page): Promise<void> {
    // Native <select> is the common case.
    const selectCandidates: readonly Locator[] = [
      page.getByLabel(/api type/i),
      page.locator('select[name*="api_key_type" i]'),
      page.locator('select[name*="type" i]'),
    ];
    for (const candidate of selectCandidates) {
      const target = candidate.first();
      try {
        await target.waitFor({ state: 'visible', timeout: PROBE_TIMEOUT_MS });
        await target.selectOption({ label: 'Harvest' });
        return;
      } catch {
        // Fall through to a custom-dropdown strategy.
      }
    }
    // Some UIs render a custom combobox: open it, then click the Harvest option.
    try {
      await clickAny(
        [page.getByRole('combobox', { name: /api type/i }), page.getByText(/select api type/i)],
        'the API type dropdown',
        PROBE_TIMEOUT_MS
      );
    } catch {
      // The dropdown may already be open; ignore.
    }
    await clickAny(
      [page.getByRole('option', { name: /^harvest$/i }), page.getByText(/^harvest$/i)],
      'the "Harvest" API type option',
      DEFAULT_TIMEOUT_MS
    );
  }

  /**
   * Best-effort selection of a partner. Greenhouse requires a partner for new
   * keys; an "Unlisted Vendor"/"Other" option exists for in-house integrations.
   * A miss here is not fatal because some orgs default the field.
   */
  private async selectPartner(page: Page): Promise<void> {
    const selectCandidates: readonly Locator[] = [
      page.getByLabel(/partner/i),
      page.locator('select[name*="partner" i]'),
    ];
    for (const candidate of selectCandidates) {
      const target = candidate.first();
      try {
        await target.waitFor({ state: 'visible', timeout: PROBE_TIMEOUT_MS });
        try {
          await target.selectOption({ label: 'Unlisted Vendor' });
        } catch {
          // Fall back to the first real (non-placeholder) option.
          await target.selectOption({ index: 1 });
        }
        return;
      } catch {
        // Try the next strategy.
      }
    }
    // Custom combobox variant; entirely best-effort.
    try {
      await clickAny(
        [page.getByRole('combobox', { name: /partner/i })],
        'the partner dropdown',
        PROBE_TIMEOUT_MS
      );
      await clickAny(
        [page.getByRole('option', { name: /unlisted|other/i }), page.getByRole('option').nth(1)],
        'a partner option',
        PROBE_TIMEOUT_MS
      );
    } catch {
      // Leave the field as-is; some orgs don't require an explicit partner.
    }
  }

  /** Fill the key's description/name field with the generated name. */
  private async fillDescription(page: Page, keyName: string): Promise<void> {
    const candidates: readonly Locator[] = [
      page.getByLabel(/description|name/i),
      page.locator('input[name*="description" i]'),
      page.locator('input[name*="name" i]'),
      page.locator('input[type="text"]').first(),
    ];
    for (const candidate of candidates) {
      const target = candidate.first();
      try {
        await target.waitFor({ state: 'visible', timeout: PROBE_TIMEOUT_MS });
        await typeLikeHuman(page, target, keyName);
        return;
      } catch {
        // Try the next strategy.
      }
    }
    throw new LoginFailedError(
      `Could not find the API key description field in Greenhouse. ${SELECTOR_CAVEAT}`
    );
  }

  /**
   * Tick the "I have stored the API Key" confirmation, if present. Best-effort:
   * the checkbox/button name varies, and some flows don't require it.
   */
  private async confirmKeyStored(page: Page): Promise<void> {
    try {
      const checkbox = page
        .getByRole('checkbox', { name: /stored the api key|stored the key|secure location/i })
        .first();
      await checkbox.waitFor({ state: 'visible', timeout: PROBE_TIMEOUT_MS });
      if (!(await checkbox.isChecked())) {
        await checkbox.click();
      }
    } catch {
      // No confirmation checkbox surfaced; continue.
    }
    // A "Continue"/"I understand" button sometimes separates the key reveal from
    // the permission step.
    try {
      await clickAny(
        [
          page.getByRole('button', { name: /i understand|continue|next/i }),
          page.getByRole('link', { name: /continue|next/i }),
        ],
        'the key-stored confirmation button',
        PROBE_TIMEOUT_MS
      );
    } catch {
      // Permission controls may already be on the same page; continue.
    }
  }

  /**
   * Enable endpoint permissions. Prefer a single "Select all"/"Enable all"
   * control; otherwise enable the specific reads the integration needs
   * (users + candidates). Best-effort throughout.
   */
  private async selectPermissions(page: Page): Promise<void> {
    // Try a bulk "enable all" control first.
    const enableAllCandidates: readonly Locator[] = [
      page.getByRole('checkbox', { name: /select all|enable all/i }),
      page.getByRole('button', { name: /select all|enable all/i }),
      page.getByText(/enable all endpoints/i),
    ];
    for (const candidate of enableAllCandidates) {
      const target = candidate.first();
      try {
        await target.waitFor({ state: 'visible', timeout: PROBE_TIMEOUT_MS });
        await target.click();
        return;
      } catch {
        // Fall back to per-endpoint selection.
      }
    }

    // Per-endpoint fallback: enable read access for users and candidates so the
    // GET /v1/users credential check (and candidate reads) succeed.
    const endpointNames: readonly RegExp[] = [
      /get.*\/users/i,
      /get.*\/candidates/i,
      /\busers\b/i,
      /\bcandidates\b/i,
    ];
    let enabledAny = false;
    for (const name of endpointNames) {
      const checkbox = page.getByRole('checkbox', { name }).first();
      try {
        await checkbox.waitFor({ state: 'visible', timeout: PROBE_TIMEOUT_MS });
        if (!(await checkbox.isChecked())) {
          await checkbox.click();
        }
        enabledAny = true;
      } catch {
        // Best-effort; ignore individual permission misses.
      }
    }
    if (!enabledAny) {
      throw new LoginFailedError(
        `Could not select any Greenhouse Harvest endpoint permissions. ${SELECTOR_CAVEAT}`
      );
    }
  }
}

export class Greenhouse extends Service {
  readonly name = 'greenhouse';
  readonly displayName = 'Greenhouse';
  readonly baseApiUrls = ['https://harvest.greenhouse.io/'] as const;
  readonly loginUrl = 'https://app.greenhouse.io/';
  readonly info =
    'https://developers.greenhouse.io/harvest.html. ' +
    'The Harvest API uses HTTP Basic auth with your API key as the username and a blank ' +
    'password. Run `latchkey auth browser greenhouse` to log in and have a Harvest API key ' +
    'created automatically (under Configure -> Dev Center -> API Credential Management) and ' +
    'stored for you, or create a key by hand there and store it with ' +
    '`latchkey auth set-nocurl greenhouse <api-key>`. The credential check uses GET /v1/users, ' +
    'so the key needs at least read access to users (and candidates).';

  readonly credentialCheckCurlArguments = ['https://harvest.greenhouse.io/v1/users'] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set-nocurl ${serviceName} <api-key>`;
  }

  override getCredentialsNoCurl(arguments_: readonly string[]): ApiCredentials {
    const apiKey = arguments_[0];
    if (arguments_.length !== 1 || apiKey === undefined || apiKey === '') {
      throw new GreenhouseCredentialError(
        'Expected exactly one argument: the Greenhouse Harvest API key.\n' +
          'Example: latchkey auth set-nocurl greenhouse <api-key>'
      );
    }
    // Harvest uses Basic auth with the key as the username and a blank password,
    // i.e. `Authorization: Basic base64("<key>:")`. Build that header directly
    // rather than relying on the user to remember the trailing colon.
    return harvestBasicAuth(apiKey);
  }

  override getSession(appNamePrefix: string): GreenhouseServiceSession {
    return new GreenhouseServiceSession(this, appNamePrefix);
  }
}

class GreenhouseCredentialError extends NoCurlCredentialsNotSupportedError {
  constructor(message: string) {
    super('greenhouse');
    this.message = message;
    this.name = 'GreenhouseCredentialError';
  }
}

export const GREENHOUSE = new Greenhouse();
