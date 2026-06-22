/**
 * QuickBooks Online service implementation.
 *
 * QuickBooks uses the OAuth 2.0 authorization-code grant. Intuit can't
 * auto-provision an app from a single API call the way Google Cloud can, but the
 * whole developer-portal dance is automated for the user with Playwright:
 *   - `latchkey auth browser-prepare quickbooks` opens a browser, has the user
 *     sign in to a (free) Intuit Developer account, then drives
 *     developer.intuit.com to create a QuickBooks Online sandbox app, scrape its
 *     Development client ID/secret, and register latchkey's fixed redirect URI.
 *   - `latchkey auth browser quickbooks` then runs the consent flow in that same
 *     real browser and captures the resulting tokens plus the `realmId` (company
 *     id) that Intuit returns on the callback.
 * (`auth set-nocurl quickbooks <client_id> <client_secret>` remains a manual
 * fallback for users who would rather register the app themselves.)
 *
 * Two QuickBooks-specific wrinkles are handled so callers never have to think
 * about them:
 *   - The redirect URI must be pre-registered, so the local callback server runs
 *     on a fixed port (QUICKBOOKS_CALLBACK_PORT) rather than a random one.
 *   - Every API URL must embed the realmId in its path
 *     (/v3/company/<realmId>/...). latchkey stores the realmId and substitutes it
 *     wherever the caller writes the literal "{realmId}", so an agent can issue
 *     requests without ever having to look the company id up.
 */

import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Locator, Page, Response } from 'playwright';
import { z } from 'zod';
import { ApiCredentials, ApiCredentialsUsageError } from '../apiCredentials/base.js';
import { runCaptured } from '../curl.js';
import type { EncryptedStorage } from '../encryptedStorage.js';
import { OAuthTokenExchangeError, startOAuthCallbackServerForParams } from '../oauthUtils.js';
import {
  showSpinnerPage,
  typeLikeHuman,
  withTempBrowserContext,
  type BrowserLaunchOptions,
} from '../playwrightUtils.js';
import {
  Service,
  ServiceSession,
  LoginFailedError,
  LoginCancelledError,
  NoCurlCredentialsNotSupportedError,
  isBrowserClosedError,
  isTimeoutError,
} from './core/base.js';

const QUICKBOOKS_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const QUICKBOOKS_TOKEN_ENDPOINT = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QUICKBOOKS_USERINFO_URL = 'https://accounts.platform.intuit.com/v1/openid_connect/userinfo';

// `openid` lets the (scope- and realm-independent) userinfo endpoint serve as the
// credential check; `accounting` grants access to the QuickBooks Online data API.
const QUICKBOOKS_SCOPE = 'com.intuit.quickbooks.accounting openid';

// Intuit requires the exact redirect URI (including port) to be pre-registered on
// the app, so the callback server binds a fixed port instead of a random one. The
// user registers this exact URI in their Intuit Developer app.
const QUICKBOOKS_CALLBACK_PORT = 8765;
const QUICKBOOKS_CALLBACK_PATH = '/callback';
const QUICKBOOKS_REDIRECT_URI = `http://localhost:${QUICKBOOKS_CALLBACK_PORT.toString()}${QUICKBOOKS_CALLBACK_PATH}`;

// Placeholder callers can put in a URL path in place of the company id; latchkey
// substitutes the stored realmId at request time.
const REALM_PLACEHOLDER = '{realmId}';

const LOGIN_TIMEOUT_MS = 300_000;
const EXPIRY_BUFFER_MS = 60_000;

// --- browser-prepare flow (Intuit Developer portal automation) ---
// The signed-in "My Apps" dashboard; unauthenticated visitors are redirected to
// Intuit's hosted sign-in page and bounced back here afterwards.
const INTUIT_MY_APPS_URL = 'https://developer.intuit.com/app/developer/myapps';
// Intuit's portal is heavier than most, so give navigations and actions room.
const PREPARE_NAV_TIMEOUT_MS = 30_000;
const PREPARE_ACTION_TIMEOUT_MS = 30_000;
// Signing in (creating the free account, MFA, etc.) is human-paced.
const PREPARE_SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

interface QuickBooksTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

function buildBasicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

function parseTokenResponse(stdout: string): QuickBooksTokenResponse | null {
  try {
    const response = JSON.parse(stdout) as Partial<QuickBooksTokenResponse>;
    if (
      typeof response.access_token !== 'string' ||
      typeof response.refresh_token !== 'string' ||
      typeof response.expires_in !== 'number'
    ) {
      return null;
    }
    return {
      access_token: response.access_token,
      refresh_token: response.refresh_token,
      expires_in: response.expires_in,
    };
  } catch {
    return null;
  }
}

/**
 * Exchange an authorization code for tokens. Intuit authenticates the client with
 * an HTTP Basic header (not body parameters), so this can't reuse the generic
 * oauthUtils exchange. Throws on failure.
 */
function exchangeQuickBooksCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string
): QuickBooksTokenResponse {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  }).toString();

  const result = runCaptured(
    [
      '-s',
      '-X',
      'POST',
      '-H',
      `Authorization: ${buildBasicAuthHeader(clientId, clientSecret)}`,
      '-H',
      'Accept: application/json',
      '-H',
      'Content-Type: application/x-www-form-urlencoded',
      '-d',
      body,
      QUICKBOOKS_TOKEN_ENDPOINT,
    ],
    30
  );

  if (result.returncode !== 0) {
    throw new OAuthTokenExchangeError(
      `Failed to exchange authorization code for tokens: ${result.stderr}`
    );
  }
  const tokens = parseTokenResponse(result.stdout);
  if (tokens === null) {
    throw new OAuthTokenExchangeError('QuickBooks token response missing access or refresh token.');
  }
  return tokens;
}

/**
 * Refresh tokens using the (rotating) refresh token. Returns null on failure.
 */
function refreshQuickBooksToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): QuickBooksTokenResponse | null {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }).toString();

  const result = runCaptured(
    [
      '-s',
      '-X',
      'POST',
      '-H',
      `Authorization: ${buildBasicAuthHeader(clientId, clientSecret)}`,
      '-H',
      'Accept: application/json',
      '-H',
      'Content-Type: application/x-www-form-urlencoded',
      '-d',
      body,
      QUICKBOOKS_TOKEN_ENDPOINT,
    ],
    30
  );

  if (result.returncode !== 0) {
    return null;
  }
  return parseTokenResponse(result.stdout);
}

/**
 * QuickBooks Online OAuth credentials.
 *
 * Holds the client ID/secret (always) and, once authorized, the access/refresh
 * tokens and the connected company's realmId. The access token is injected as
 * `Authorization: Bearer`, and any "{realmId}" in the request URL is replaced
 * with the stored company id.
 */
export const QuickBooksCredentialsSchema = z.object({
  objectType: z.literal('quickbooks'),
  clientId: z.string(),
  clientSecret: z.string(),
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  realmId: z.string().optional(),
  accessTokenExpiresAt: z.string().optional(),
});

export type QuickBooksCredentialsData = z.infer<typeof QuickBooksCredentialsSchema>;

export class QuickBooksCredentials implements ApiCredentials {
  readonly objectType = 'quickbooks' as const;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly realmId?: string;
  readonly accessTokenExpiresAt?: string;

  constructor(
    clientId: string,
    clientSecret: string,
    accessToken?: string,
    refreshToken?: string,
    realmId?: string,
    accessTokenExpiresAt?: string
  ) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.realmId = realmId;
    this.accessTokenExpiresAt = accessTokenExpiresAt;
  }

  injectIntoCurlCall(curlArguments: readonly string[]): Promise<readonly string[]> {
    if (this.accessToken === undefined) {
      throw new ApiCredentialsUsageError(
        'QuickBooks credentials are not authorized yet. Run `latchkey auth browser quickbooks` to sign in.'
      );
    }
    const realmId = this.realmId;
    const substituted =
      realmId === undefined
        ? [...curlArguments]
        : curlArguments.map((argument) => argument.split(REALM_PLACEHOLDER).join(realmId));
    return Promise.resolve(['-H', `Authorization: Bearer ${this.accessToken}`, ...substituted]);
  }

  isExpired(): boolean | undefined {
    // Without an access token the credentials need an interactive browser login,
    // not a token refresh, so don't report "expired" (which would trigger refresh).
    if (this.accessToken === undefined || this.accessTokenExpiresAt === undefined) {
      return undefined;
    }
    return Date.now() >= new Date(this.accessTokenExpiresAt).getTime() - EXPIRY_BUFFER_MS;
  }

  /**
   * Return a copy carrying refreshed tokens (the realmId and client credentials
   * are preserved).
   */
  withRefreshedTokens(
    accessToken: string,
    refreshToken: string,
    accessTokenExpiresAt: string
  ): QuickBooksCredentials {
    return new QuickBooksCredentials(
      this.clientId,
      this.clientSecret,
      accessToken,
      refreshToken,
      this.realmId,
      accessTokenExpiresAt
    );
  }

  toJSON(): QuickBooksCredentialsData {
    return {
      objectType: this.objectType,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      realmId: this.realmId,
      accessTokenExpiresAt: this.accessTokenExpiresAt,
    };
  }

  static fromJSON(data: QuickBooksCredentialsData): QuickBooksCredentials {
    return new QuickBooksCredentials(
      data.clientId,
      data.clientSecret,
      data.accessToken,
      data.refreshToken,
      data.realmId,
      data.accessTokenExpiresAt
    );
  }
}

class QuickBooksCredentialError extends NoCurlCredentialsNotSupportedError {
  constructor(message: string) {
    super('quickbooks');
    this.message = message;
    this.name = 'QuickBooksCredentialError';
  }
}

/*
 * ===========================================================================
 * BROWSER-PREPARE FLOW — Intuit Developer portal automation
 * ===========================================================================
 *
 * !!! SELECTORS BELOW ARE BEST-EFFORT AND UNVERIFIED. !!!
 *
 * Unlike the Google flow (src/services/google/base.ts), which was authored and
 * tuned against a live Google Cloud Console, the prepare() flow here was written
 * WITHOUT access to a live Intuit Developer account. Every URL, selector, and
 * step ordering below is a best-effort guess at the developer.intuit.com UI and
 * MUST be recorded against the real portal and corrected before it can be relied
 * on. To record the real flow and fix these selectors (see docs/development.md
 * -> "Potentially useful helpers"):
 *
 *   npx tsx scripts/codegen.ts quickbooks https://developer.intuit.com/app/developer/myapps
 *   npx tsx scripts/recordBrowserSession.ts quickbooks
 *
 * The flow is deliberately defensive — explicit waits, generous timeouts, and
 * actionable LoginFailedError messages — so that a wrong selector fails loudly
 * at a named step instead of hanging or silently returning empty credentials.
 * Semantic locators (getByRole/getByText/getByPlaceholder) are preferred over
 * brittle CSS/XPath because they are more likely to survive portal redesigns.
 * ===========================================================================
 */

/** Escape a string for safe inclusion inside a `RegExp`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Locate the "Create an app" call-to-action, which the portal renders as either
 * a link or a button depending on whether the developer already has apps.
 */
function createAppButtonLocator(page: Page): Locator {
  return page
    .getByRole('link', { name: /create an app/i })
    .or(page.getByRole('button', { name: /create an app/i }))
    .first();
}

/**
 * Wait for the user to sign in to the Intuit Developer portal.
 *
 * The portal redirects unauthenticated visitors to Intuit's hosted sign-in
 * page, so surface the browser and wait (human-paced) for the signed-in "My
 * Apps" dashboard — detected via the "Create an app" CTA — to appear.
 */
async function waitForIntuitSignIn(page: Page): Promise<void> {
  await page.goto(INTUIT_MY_APPS_URL, { timeout: PREPARE_NAV_TIMEOUT_MS });
  await page.bringToFront();

  const createAppButton = createAppButtonLocator(page);
  try {
    await createAppButton.waitFor({ state: 'visible', timeout: PREPARE_SIGN_IN_TIMEOUT_MS });
  } catch (error: unknown) {
    if (error instanceof Error && isTimeoutError(error)) {
      throw new LoginFailedError(
        'Error: Timed out waiting for sign-in to the Intuit Developer portal at ' +
          `${INTUIT_MY_APPS_URL}. Sign in (a free developer account is enough) and try again.`
      );
    }
    throw error;
  }
}

/**
 * Drive the create-app wizard to create a QuickBooks Online (sandbox) app.
 */
async function createQuickBooksApp(page: Page, appName: string): Promise<void> {
  const createAppButton = createAppButtonLocator(page);
  await createAppButton.waitFor({ state: 'visible', timeout: PREPARE_ACTION_TIMEOUT_MS });
  await createAppButton.click();

  // Choose the "QuickBooks Online and Payments" platform card.
  const platformCard = page.getByText(/quickbooks online and payments/i).first();
  try {
    await platformCard.waitFor({ state: 'visible', timeout: PREPARE_ACTION_TIMEOUT_MS });
  } catch (error: unknown) {
    if (error instanceof Error && isTimeoutError(error)) {
      throw new LoginFailedError(
        'Error: Could not find the "QuickBooks Online and Payments" option on the Intuit ' +
          'Developer create-app screen.'
      );
    }
    throw error;
  }
  await platformCard.click();

  // Name the app.
  const appNameInput = page.getByRole('textbox', { name: /name/i }).first();
  try {
    await appNameInput.waitFor({ state: 'visible', timeout: PREPARE_ACTION_TIMEOUT_MS });
  } catch (error: unknown) {
    if (error instanceof Error && isTimeoutError(error)) {
      throw new LoginFailedError(
        'Error: Could not find the app-name field on the Intuit create-app screen.'
      );
    }
    throw error;
  }
  await appNameInput.click();
  await typeLikeHuman(page, appNameInput, appName);

  // Select the accounting scope (the QuickBooks Online data API latchkey uses).
  // Best-effort: not every layout requires an explicit scope selection here.
  const accountingScope = page.getByText(/com\.intuit\.quickbooks\.accounting/i).first();
  if (await accountingScope.isVisible().catch(() => false)) {
    await accountingScope.click().catch(() => undefined);
  }

  // Accept any EULA/terms checkbox the wizard shows.
  const termsCheckbox = page.getByRole('checkbox').first();
  if (await termsCheckbox.isVisible().catch(() => false)) {
    await termsCheckbox.check().catch(() => undefined);
  }

  // Submit the wizard.
  const submitButton = page.getByRole('button', { name: /create app/i }).first();
  await submitButton.waitFor({ state: 'visible', timeout: PREPARE_ACTION_TIMEOUT_MS });
  await submitButton.click();
}

/**
 * Open the new app's "Keys & credentials" -> "Development" (sandbox) section.
 */
async function openDevelopmentKeys(page: Page): Promise<void> {
  const keysNav = page
    .getByRole('link', { name: /keys & credentials/i })
    .or(page.getByRole('button', { name: /keys & credentials/i }))
    .first();
  try {
    await keysNav.waitFor({ state: 'visible', timeout: PREPARE_NAV_TIMEOUT_MS });
  } catch (error: unknown) {
    if (error instanceof Error && isTimeoutError(error)) {
      throw new LoginFailedError(
        'Error: Could not open "Keys & credentials" for the newly created QuickBooks app.'
      );
    }
    throw error;
  }
  await keysNav.click();

  // Make sure we read the Development (sandbox) keys, not Production.
  const developmentTab = page
    .getByRole('tab', { name: /development/i })
    .or(page.getByRole('link', { name: /^\s*development\s*$/i }))
    .first();
  if (await developmentTab.isVisible().catch(() => false)) {
    await developmentTab.click().catch(() => undefined);
  }
}

/**
 * Read a labeled credential value (Client ID / Client Secret) from the keys
 * page. The portal renders these in read-only inputs; a masked secret may need
 * a "reveal" toggle clicked first.
 */
async function scrapeCredential(page: Page, fieldName: string): Promise<string> {
  const label = new RegExp(escapeRegExp(fieldName), 'i');
  const field = page.getByRole('textbox', { name: label }).first();
  try {
    await field.waitFor({ state: 'visible', timeout: PREPARE_ACTION_TIMEOUT_MS });
  } catch (error: unknown) {
    if (error instanceof Error && isTimeoutError(error)) {
      throw new LoginFailedError(
        `Error: Could not find the QuickBooks ${fieldName} field on the developer portal.`
      );
    }
    throw error;
  }

  let value = (await field.inputValue().catch(() => '')).trim();
  if (value === '') {
    // The secret may be hidden behind a reveal toggle; best-effort reveal + retry.
    const revealButton = page.getByRole('button', { name: /show|reveal/i }).first();
    if (await revealButton.isVisible().catch(() => false)) {
      await revealButton.click().catch(() => undefined);
      value = (await field.inputValue().catch(() => '')).trim();
    }
  }
  if (value === '') {
    throw new LoginFailedError(
      `Error: Read an empty QuickBooks ${fieldName} from the developer portal.`
    );
  }
  return value;
}

/**
 * Register latchkey's fixed redirect URI on the app's Development keys.
 */
async function addRedirectUri(page: Page, redirectUri: string): Promise<void> {
  // Some layouts hide the input behind an "Add URI" affordance.
  const addUriButton = page
    .getByRole('button', { name: /add uri/i })
    .or(page.getByRole('link', { name: /add uri/i }))
    .first();
  if (await addUriButton.isVisible().catch(() => false)) {
    await addUriButton.click().catch(() => undefined);
  }

  const redirectInput = page
    .getByRole('textbox', { name: /redirect uri/i })
    .or(page.getByPlaceholder(/redirect uri/i))
    .first();
  try {
    await redirectInput.waitFor({ state: 'visible', timeout: PREPARE_ACTION_TIMEOUT_MS });
  } catch (error: unknown) {
    if (error instanceof Error && isTimeoutError(error)) {
      throw new LoginFailedError(
        'Error: Could not find the redirect-URI field for the new QuickBooks app.'
      );
    }
    throw error;
  }
  await redirectInput.click();
  await typeLikeHuman(page, redirectInput, redirectUri);

  const saveButton = page.getByRole('button', { name: /save/i }).first();
  await saveButton.waitFor({ state: 'visible', timeout: PREPARE_ACTION_TIMEOUT_MS });
  await saveButton.click();

  // Give the save a beat to persist before the context is torn down.
  await page.waitForTimeout(2000);
}

class QuickBooksServiceSession extends ServiceSession {
  onResponse(_response: Response): void {
    // The OAuth callback is delivered to the local HTTP server, not observed as a
    // page response, so nothing to do here.
  }

  protected isLoginComplete(): boolean {
    // Go straight to the OAuth flow; the user interacts with Intuit's hosted
    // consent screen during finalizeCredentials.
    return true;
  }

  protected async finalizeCredentials(
    _browser: Browser,
    context: BrowserContext,
    oldCredentials?: ApiCredentials
  ): Promise<ApiCredentials | null> {
    const page = context.pages()[0];
    if (!page) {
      throw new LoginFailedError('No page available in browser context.');
    }
    if (!(oldCredentials instanceof QuickBooksCredentials)) {
      throw new LoginFailedError(
        'QuickBooks login requires client credentials. Run ' +
          '`latchkey auth set-nocurl quickbooks <client_id> <client_secret>` first.'
      );
    }
    const { clientId, clientSecret } = oldCredentials;

    const abortController = new AbortController();
    const closeHandler = () => {
      abortController.abort();
    };
    page.on('close', closeHandler);
    context.on('close', closeHandler);

    try {
      const { paramsPromise } = await startOAuthCallbackServerForParams(
        LOGIN_TIMEOUT_MS,
        abortController.signal,
        QUICKBOOKS_CALLBACK_PATH,
        QUICKBOOKS_CALLBACK_PORT
      );

      const authUrl = new URL(QUICKBOOKS_AUTHORIZE_URL);
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', QUICKBOOKS_SCOPE);
      authUrl.searchParams.set('redirect_uri', QUICKBOOKS_REDIRECT_URI);
      authUrl.searchParams.set('state', randomUUID());

      await page.goto(authUrl.toString());

      const params = await paramsPromise;
      const code = params.code;
      if (code === undefined || code === '') {
        throw new LoginFailedError('QuickBooks did not return an authorization code.');
      }
      const realmId = params.realmId;
      if (realmId === undefined || realmId === '') {
        throw new LoginFailedError('QuickBooks did not return a realmId (company id).');
      }

      const tokens = exchangeQuickBooksCode(clientId, clientSecret, code, QUICKBOOKS_REDIRECT_URI);
      const accessTokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

      await page.close();

      return new QuickBooksCredentials(
        clientId,
        clientSecret,
        tokens.access_token,
        tokens.refresh_token,
        realmId,
        accessTokenExpiresAt
      );
    } catch (error: unknown) {
      if (error instanceof Error && isBrowserClosedError(error)) {
        throw new LoginCancelledError();
      }
      throw error;
    } finally {
      page.off('close', closeHandler);
      context.off('close', closeHandler);
    }
  }

  override async prepare(
    encryptedStorage: EncryptedStorage,
    launchOptions?: BrowserLaunchOptions
  ): Promise<ApiCredentials> {
    return withTempBrowserContext(encryptedStorage, launchOptions ?? {}, async ({ context }) => {
      const page = await context.newPage();
      return this.runPrepareFlow(context, page);
    });
  }

  /**
   * Sign in -> create a sandbox app -> scrape its Development client ID/secret ->
   * register the redirect URI. Returns client credentials with no tokens; the
   * OAuth consent flow (finalizeCredentials) mints the tokens and realmId later
   * when the user runs `latchkey auth browser quickbooks`.
   */
  private async runPrepareFlow(
    context: BrowserContext,
    page: Page
  ): Promise<QuickBooksCredentials> {
    await waitForIntuitSignIn(page);

    // Hide the rest of the automation from the user behind a spinner.
    await showSpinnerPage(
      context,
      'Finalizing QuickBooks setup by creating a sandbox app on the Intuit ' +
        'Developer portal...\nThis can take a minute.'
    );

    const appName = this.generateAppName('-quickbooks');
    await createQuickBooksApp(page, appName);

    await openDevelopmentKeys(page);
    const clientId = await scrapeCredential(page, 'Client ID');
    const clientSecret = await scrapeCredential(page, 'Client Secret');
    await addRedirectUri(page, QUICKBOOKS_REDIRECT_URI);

    await page.close();

    return new QuickBooksCredentials(clientId, clientSecret);
  }
}

export class Quickbooks extends Service {
  readonly name = 'quickbooks';
  readonly displayName = 'QuickBooks';
  readonly baseApiUrls = [
    'https://quickbooks.api.intuit.com/',
    'https://sandbox-quickbooks.api.intuit.com/',
  ] as const;
  readonly loginUrl = 'https://quickbooks.intuit.com/';
  readonly info =
    'https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/account. ' +
    'OAuth 2.0 authorization-code flow with automatic, browser-driven setup. First run ' +
    '`latchkey auth browser-prepare quickbooks`: it opens a browser, has you sign in to a (free) ' +
    'Intuit Developer account, then automatically creates a QuickBooks Online sandbox app, reads ' +
    'its Development client ID/secret, and registers the redirect URI ' +
    `${QUICKBOOKS_REDIRECT_URI} (note http://localhost, not https). Then run ` +
    '`latchkey auth browser quickbooks` to sign in and grant consent. (Advanced: you can instead ' +
    'register the app yourself and run `latchkey auth set-nocurl quickbooks <client_id> ' +
    '<client_secret>`.) Every API URL must include the company id; write "{realmId}" in the path ' +
    '(e.g. https://quickbooks.api.intuit.com/v3/company/{realmId}/companyinfo/{realmId}) and ' +
    'latchkey fills in the connected company automatically. Use the ' +
    'sandbox-quickbooks.api.intuit.com host for sandbox companies. Pass `-H "Accept: ' +
    'application/json"` to get JSON instead of XML.';

  // The userinfo endpoint validates the token independently of scope, realm, and
  // environment (sandbox vs production), so it works for any authorized credential.
  readonly credentialCheckCurlArguments = [QUICKBOOKS_USERINFO_URL] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set-nocurl ${serviceName} <client_id> <client_secret>`;
  }

  override getCredentialsNoCurl(arguments_: readonly string[]): ApiCredentials {
    const [clientId, clientSecret] = arguments_;
    if (
      arguments_.length !== 2 ||
      clientId === undefined ||
      clientId === '' ||
      clientSecret === undefined ||
      clientSecret === ''
    ) {
      throw new QuickBooksCredentialError(
        'Expected exactly two arguments: the client ID and client secret.\n' +
          'Example: latchkey auth set-nocurl quickbooks <client_id> <client_secret>\n' +
          'Then run `latchkey auth browser quickbooks` to authorize.'
      );
    }
    return new QuickBooksCredentials(clientId, clientSecret);
  }

  override getSession(appNamePrefix: string): QuickBooksServiceSession {
    return new QuickBooksServiceSession(this, appNamePrefix);
  }

  override refreshCredentials(apiCredentials: ApiCredentials): Promise<ApiCredentials | null> {
    if (!(apiCredentials instanceof QuickBooksCredentials) || !apiCredentials.refreshToken) {
      return Promise.resolve(null);
    }
    const tokens = refreshQuickBooksToken(
      apiCredentials.clientId,
      apiCredentials.clientSecret,
      apiCredentials.refreshToken
    );
    if (tokens === null) {
      return Promise.resolve(null);
    }
    const accessTokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    return Promise.resolve(
      apiCredentials.withRefreshedTokens(
        tokens.access_token,
        tokens.refresh_token,
        accessTokenExpiresAt
      )
    );
  }
}

export const QUICKBOOKS = new Quickbooks();
