/**
 * Spotify service implementation.
 *
 * Spotify is a *session-cookie + silent re-mint* service (the "Shape 6"
 * connector from the latchkey-dev-workbench design doc). The web player holds a
 * long-lived `sp_dc` cookie (~1 year) and silently mints a short-lived bearer
 * (~10-15 min) via `https://open.spotify.com/api/token?...&totp=<TOTP>`. The
 * TOTP is computed by the SPA's own JS, so the mint is NOT HTTP-reducible; a
 * browser must run it.
 *
 * There is no personal API key (so no key scrape), and the official Developer
 * App (OAuth) path requires Spotify Premium (blocked for Free accounts as of
 * Feb 2026). The public `api.spotify.com/v1` is rate-limited (429) for the
 * web-player token; the connector therefore rides the web player's own API at
 * `spclient.wg.spotify.com` (REST-like, confirmed 200 with this token).
 *
 * Auth shape:
 * - Acquisition: a browser login (modelled on ngrok's BrowserFollowupServiceSession).
 *   The user signs into accounts.spotify.com → open.spotify.com; once logged
 *   in, the followup step reads `sp_dc` from the context's cookies and mints
 *   the initial bearer by capturing the SPA's own `/api/token` response.
 * - Injection: `Authorization: Bearer <accessToken>` on every spclient call.
 * - Refresh: `refreshCredentials` does a LAZY headless re-mint — launches a
 *   headless Chrome with `sp_dc` set, loads open.spotify.com so the SPA
 *   computes the TOTP and hits /api/token, captures the response bearer + its
 *   `accessTokenExpirationTimestampMs`, returns new credentials. Mint happens
 *   ONLY when a call arrives with an expired token (no idle minting).
 *
 * This rides Spotify's undocumented first-party web client (ToS-gray) and can
 * break if Spotify changes the web login/mint. The durable path is an upstream
 * latchkey PR + the sanctioned OAuth connector if the account ever goes Premium.
 */
import type { BrowserContext, Page, Response } from 'playwright';
import { z } from 'zod';
import {
  ApiCredentials,
  ApiCredentialsUsageError,
  ApiCredentialStatus,
} from '../apiCredentials/base.js';
import { loadPlaywright } from '../playwrightLoader.js';
import {
  Service,
  BrowserFollowupServiceSession,
  FollowupWork,
  LoginFailedError,
} from './core/base.js';

const SPOTIFY_LOGIN_URL = 'https://accounts.spotify.com/en/login';
const SPOTIFY_WEB_PLAYER_URL = 'https://open.spotify.com/';
const SPOTIFY_API_TOKEN_URL_PREFIX = 'https://open.spotify.com/api/token';
const SPOTIFY_OPEN_HOST = 'open.spotify.com';
const SPOTIFY_ACCOUNTS_HOST = 'accounts.spotify.com';
// The /en/status path on accounts.spotify.com is the post-login success landing
// (the browser may stay there instead of redirecting to open.spotify.com).
const SPOTIFY_PRE_LOGIN_PATH_PATTERN = /^\/(login|signup|signin|auth|sso|oauth|verify|mfa|otp)/i;

// The web player's own API (REST-like). Confirmed 200 with the web-player bearer.
// The web player's own API (REST-like). Confirmed 200 with the web-player bearer.
// All the data-API calls (profile, playlists, library) go to this single host;
// the guc3-spclient.spotify.com variant is for playback-state, not the data API.
const SPOTIFY_API_BASE_URLS = ['https://spclient.wg.spotify.com/'] as const;

// --- Credentials ---

/**
 * Stored Spotify credentials: the durable `sp_dc` session cookie, plus a cached
 * short-lived `accessToken` and its expiry (ms epoch). The access token is
 * minted from `sp_dc` on demand (see {@link SpotifyService.refreshCredentials});
 * there is no refresh token.
 */
export const SpotifySessionCredentialsSchema = z.object({
  objectType: z.literal('spotifySession'),
  sp_dc: z.string(),
  accessToken: z.string().optional(),
  accessTokenExpiresAt: z.number().optional(), // ms epoch
});
export type SpotifySessionCredentialsData = z.infer<typeof SpotifySessionCredentialsSchema>;

export class SpotifySessionCredentials implements ApiCredentials {
  readonly objectType = 'spotifySession' as const;
  constructor(
    readonly sp_dc: string,
    readonly accessToken?: string,
    readonly accessTokenExpiresAt?: number
  ) {}

  injectIntoCurlCall(curlArguments: readonly string[]): Promise<string[]> {
    if (!this.accessToken) {
      throw new ApiCredentialsUsageError(
        'Spotify credentials missing access token. The token is minted from ' +
          'sp_dc on first use; run `latchkey curl` again to trigger a mint.'
      );
    }
    return Promise.resolve(['-H', `Authorization: Bearer ${this.accessToken}`, ...curlArguments]);
  }

  /**
   * True when the access token is missing or past its expiry (with a 1-min
   * margin so we re-mint slightly before it actually expires). The injection
   * pipeline triggers refresh only when this returns exactly `true`, so we
   * return `true` (not `undefined`) when there is no token yet.
   */
  isExpired(): boolean {
    if (!this.accessToken || this.accessTokenExpiresAt === undefined) {
      return true;
    }
    const marginMs = 60_000;
    return Date.now() >= this.accessTokenExpiresAt - marginMs;
  }

  toJSON(): SpotifySessionCredentialsData {
    return {
      objectType: this.objectType,
      sp_dc: this.sp_dc,
      accessToken: this.accessToken,
      accessTokenExpiresAt: this.accessTokenExpiresAt,
    };
  }

  static fromJSON(data: SpotifySessionCredentialsData): SpotifySessionCredentials {
    return new SpotifySessionCredentials(data.sp_dc, data.accessToken, data.accessTokenExpiresAt);
  }
}

// --- Mint helper (shared by login finalize + refresh) ---

interface MintResult {
  readonly accessToken: string;
  readonly expiresAt: number; // ms epoch
  readonly isAnonymous: boolean;
}

/**
 * Read `sp_dc` from a logged-in browser context's cookies.
 * @returns the sp_dc cookie value, or null if not present.
 */
async function readSpDc(context: BrowserContext): Promise<string | null> {
  const cookies = await context.cookies('https://open.spotify.com/');
  const spDc = cookies.find((c) => c.name === 'sp_dc');
  return spDc?.value ?? null;
}

/**
 * Mint a fresh bearer by loading the web player (so the SPA computes the TOTP
 * and hits /api/token) and capturing the response. The page must already be on
 * open.spotify.com (or be navigated there). Captures the bearer + its expiry
 * from the /api/token JSON response.
 */
async function mintFromPage(page: Page): Promise<MintResult> {
  return new Promise<MintResult>((resolve, reject) => {
    let settled = false;
    const done = (r: MintResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const fail = (e: Error) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    };

    const handler = async (response: Response) => {
      const url = response.url();
      if (!url.startsWith(SPOTIFY_API_TOKEN_URL_PREFIX)) return;
      try {
        if (response.status() !== 200) return;
        const body = (await response.json()) as {
          accessToken?: string;
          accessTokenExpirationTimestampMs?: number;
          isAnonymous?: boolean;
        };
        if (
          typeof body.accessToken === 'string' &&
          typeof body.accessTokenExpirationTimestampMs === 'number'
        ) {
          page.off('response', handler);
          done({
            accessToken: body.accessToken,
            expiresAt: body.accessTokenExpirationTimestampMs,
            isAnonymous: !!body.isAnonymous,
          });
        }
      } catch {
        // body unavailable or not JSON — ignore and keep waiting
      }
    };
    page.on('response', handler);

    // Cap the wait: the SPA mints on init (~3-8s observed); 25s is a safe ceiling.
    setTimeout(() => {
      fail(
        new LoginFailedError(
          'Spotify token mint timed out: the web player did not hit ' +
            '/api/token within 25s. sp_dc may have lapsed (re-login required) ' +
            'or Spotify changed the web login flow.'
        )
      );
    }, 25_000);
  });
}

// --- Service session (login) ---

class SpotifyServiceSession extends BrowserFollowupServiceSession {
  protected readonly followupWork = FollowupWork.RetrieveApiToken;
  private isLoggedIn = false;

  onResponse(response: Response): void {
    if (this.isLoggedIn) {
      return;
    }
    // Capture the page reference for isLoginComplete's URL polling.
    if (!this.loginPage) {
      try {
        this.loginPage = response.request().frame().page();
      } catch {
        // page may not be available yet
      }
    }
    if (response.request().resourceType() !== 'document') {
      return;
    }
    this.checkLoginComplete(new URL(response.url()));
  }

  private checkLoginComplete(url: URL): void {
    if (url.hostname === SPOTIFY_OPEN_HOST && !SPOTIFY_PRE_LOGIN_PATH_PATTERN.test(url.pathname)) {
      this.isLoggedIn = true;
    } else if (url.hostname === SPOTIFY_ACCOUNTS_HOST && url.pathname.startsWith('/en/status')) {
      this.isLoggedIn = true;
    }
  }

  // The page reference is set by the login flow before polling starts.
  private loginPage: Page | null = null;

  protected isLoginComplete(): boolean {
    if (this.isLoggedIn) {
      return true;
    }
    // Also check the current page URL directly, since Spotify's login uses
    // client-side SPA route changes that don't fire a new document response.
    if (this.loginPage) {
      try {
        const url = this.loginPage.url();
        this.checkLoginComplete(new URL(url));
      } catch {
        // page may have navigated or closed — ignore
      }
    }
    return this.isLoggedIn;
  }

  protected async performBrowserFollowup(
    context: BrowserContext,
    _oldCredentials?: ApiCredentials
  ): Promise<ApiCredentials | null> {
    const page = context.pages()[0];
    if (!page) {
      throw new LoginFailedError('No page available after Spotify login.');
    }

    // The login may have landed on accounts.spotify.com/en/status (the SPA
    // success page) rather than open.spotify.com. The /api/token mint only
    // fires when the web player SPA loads, so navigate to open.spotify.com if
    // we're not already there.
    try {
      const currentUrl = page.url();
      if (!currentUrl.includes('open.spotify.com')) {
        await page.goto(SPOTIFY_WEB_PLAYER_URL, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
      }
    } catch {
      // navigation may fail if the page is already navigating — the mint
      // listener will still catch /api/token if it fires
    }

    const sp_dc = await readSpDc(context);
    if (!sp_dc) {
      throw new LoginFailedError(
        'Spotify login completed but no sp_dc cookie was captured. ' +
          'The session may not have fully established.'
      );
    }

    const mint = await mintFromPage(page);
    if (mint.isAnonymous) {
      throw new LoginFailedError(
        'Spotify login produced an anonymous token (sp_dc not a valid session).'
      );
    }
    return new SpotifySessionCredentials(sp_dc, mint.accessToken, mint.expiresAt);
  }
}

// --- Service ---

export class Spotify extends Service {
  readonly name = 'spotify';
  readonly displayName = 'Spotify';
  readonly baseApiUrls = SPOTIFY_API_BASE_URLS;
  readonly loginUrl = SPOTIFY_LOGIN_URL;
  readonly info = [
    'Spotify (web-player session connector).',
    '',
    "Rides the Spotify web player's own session: a one-time browser login",
    'captures the long-lived sp_dc cookie (~1 year), and a short-lived bearer',
    'token (~10-15 min) is minted from it on demand by running a headless',
    "browser through the web player's own /api/token flow (the TOTP is",
    "computed by Spotify's JS, so a browser must run the mint).",
    '',
    "Calls go to the web player's API at spclient.wg.spotify.com (REST-like),",
    'NOT the public api.spotify.com/v1 (which rate-limits the web-player token).',
    '',
    'No personal API key (none exists); the official OAuth Developer-App path',
    'requires Spotify Premium (blocked for Free accounts as of Feb 2026).',
    '',
    "Caveat: rides Spotify's undocumented first-party web client (ToS-gray);",
    'can break if Spotify changes the web login/mint.',
  ].join('\n');

  // A cheap read that confirms the token works: fetch the user's own profile.
  readonly credentialCheckCurlArguments = [
    'https://spclient.wg.spotify.com/user-profile-view/v3/profile/me',
  ] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set-nocurl ${serviceName} '<your sp_dc cookie value>'   (or: latchkey auth browser ${serviceName})`;
  }

  // The account (username) is not separately known from the cookie alone.
  override getAccount(_apiCredentials: ApiCredentials): Promise<string | null> {
    return Promise.resolve(null);
  }

  override checkApiCredentials(): Promise<ApiCredentialStatus> {
    return Promise.resolve(ApiCredentialStatus.Unknown);
  }

  override getSession(appNamePrefix: string): SpotifyServiceSession {
    return new SpotifyServiceSession(this, appNamePrefix);
  }

  /**
   * Store credentials from a non-curl argument: the bare `sp_dc` cookie value.
   * Usage: `latchkey auth set-nocurl spotify <sp_dc-value>`. The access token is
   * minted from sp_dc on first use (lazy); none is stored here.
   */
  override getCredentialsNoCurl(arguments_: readonly string[]): ApiCredentials {
    // Tolerate `--sp_dc <value>` or a bare positional value.
    let value: string | undefined;
    for (let i = 0; i < arguments_.length; i++) {
      const a = arguments_[i] ?? '';
      if (a === '--sp_dc' || a === '--sp-dc') {
        value = arguments_[i + 1];
        i++;
      } else if (a.startsWith('--sp_dc=')) {
        value = a.slice('--sp_dc='.length);
      } else if (!a.startsWith('-')) {
        value = a;
      }
    }
    if (!value) {
      throw new ApiCredentialsUsageError(
        'Expected the sp_dc cookie value.\n' +
          'Example: latchkey auth set-nocurl spotify <sp_dc-value>\n' +
          '   or: latchkey auth set-nocurl spotify --sp_dc <value>'
      );
    }
    return new SpotifySessionCredentials(value);
  }

  /**
   * LAZY refresh: re-mint the access token from the stored sp_dc by running a
   * headless browser through the web player's own /api/token flow. Called by
   * the injection pipeline ONLY when isExpired() is true — so idle periods
   * mint nothing, and the ~10-min token life does NOT mean 6 launches/hour.
   *
   * No refresh token exists; sp_dc IS the refresh mechanism. If sp_dc itself
   * has lapsed (~1yr), the mint returns an anonymous token and the user must
   * re-login.
   */
  override async refreshCredentials(
    apiCredentials: ApiCredentials
  ): Promise<ApiCredentials | null> {
    if (!(apiCredentials instanceof SpotifySessionCredentials)) {
      throw new ApiCredentialsUsageError('Spotify refresh expected SpotifySessionCredentials');
    }
    const sp_dc = apiCredentials.sp_dc;
    if (!sp_dc) {
      return null; // nothing to mint from -> user must re-login
    }

    const playwright = await loadPlaywright();
    // Use the system Chrome if available (the bundled Playwright Chromium's
    // headless-shell variant may not be installed; the system Chrome is always
    // present on a Mac where Minds runs). Fall back to the bundled chromium.
    const fs = await import('node:fs');
    const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const executablePath = fs.existsSync(systemChrome) ? systemChrome : undefined;
    const browser = await playwright.chromium.launch({
      headless: true,
      executablePath,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });
    try {
      const context = await browser.newContext();
      // Inject sp_dc as a cookie on .spotify.com so the SPA recognizes the session.
      await context.addCookies([
        {
          name: 'sp_dc',
          value: sp_dc,
          domain: '.spotify.com',
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
      ]);
      const page = await context.newPage();
      // Mint happens on init; navigate and capture /api/token.
      const mintPromise = mintFromPage(page);
      await page.goto(SPOTIFY_WEB_PLAYER_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      const mint = await mintPromise;
      if (mint.isAnonymous) {
        // sp_dc is no longer a valid session — treat as refresh failure.
        throw new LoginFailedError(
          'Spotify sp_dc has expired: the minted token is anonymous. ' +
            'Re-login to capture a fresh sp_dc.'
        );
      }
      return new SpotifySessionCredentials(sp_dc, mint.accessToken, mint.expiresAt);
    } finally {
      await browser.close().catch((error: unknown) => {
        void error;
      });
    }
  }
}

export const SPOTIFY = new Spotify();
