/**
 * Slack service implementation.
 */

import type { Page, Response } from 'playwright';
import { z } from 'zod';
import type { ApiCredentials } from '../apiCredentials/base.js';
import { LoginFailedError, Service, SimpleServiceSession } from './core/base.js';
import { fetchAccountFromEndpoint, tryParseJson } from '../apiCredentials/account.js';

/**
 * Slack-specific credentials (token + d cookie).
 */
export const SlackApiCredentialsSchema = z.object({
  objectType: z.literal('slack'),
  token: z.string(),
  dCookie: z.string(),
});

export type SlackApiCredentialsData = z.infer<typeof SlackApiCredentialsSchema>;

export class SlackApiCredentials implements ApiCredentials {
  readonly objectType = 'slack' as const;
  readonly token: string;
  readonly dCookie: string;

  constructor(token: string, dCookie: string) {
    this.token = token;
    this.dCookie = dCookie;
  }

  injectIntoCurlCall(curlArguments: readonly string[]): Promise<readonly string[]> {
    return Promise.resolve([
      '-H',
      `Authorization: Bearer ${this.token}`,
      '-H',
      `Cookie: d=${this.dCookie}`,
      ...curlArguments,
    ]);
  }

  isExpired(): boolean | undefined {
    return undefined;
  }

  toJSON(): SlackApiCredentialsData {
    return {
      objectType: this.objectType,
      token: this.token,
      dCookie: this.dCookie,
    };
  }

  static fromJSON(data: SlackApiCredentialsData): SlackApiCredentials {
    return new SlackApiCredentials(data.token, data.dCookie);
  }
}

const SLACK_URL_PATTERN = /^https:\/\/([a-z0-9-]+\.)?slack\.com\//;

/** Where the browser ends up once Slack considers the user signed in. */
const SLACK_CLIENT_URL_PATTERN = /^https:\/\/app\.slack\.com\/client(\/|$)/;

/** The session token, as embedded in the client's HTML or in raw JSON. */
const API_TOKEN_PATTERN = /"api_token":"(xoxc-[a-zA-Z0-9-]+)"/;

const D_COOKIE_HEADER_PATTERN = /\bd=([^;]+)/;

/**
 * How long after the Slack client has finished loading a token is still waited
 * for. The token may arrive in the client's HTML or in a request the client
 * makes afterwards, so this is deliberately generous: it only delays the
 * failure message, never a login that is going to succeed.
 */
const TOKEN_SETTLE_PERIOD_MS = 5_000;

/**
 * Slack signed the user in but the browser has no `d` session cookie, which the
 * API needs alongside the token. Observed after "Reject cookies" in Slack's
 * cookie dialog.
 */
export class SlackSessionCookieMissingError extends LoginFailedError {
  constructor() {
    super(
      'Login failed: Slack signed you in, but the browser holds no "d" session cookie, ' +
        'which the Slack API requires alongside the token. This has been observed after ' +
        'choosing "Reject cookies" in Slack\'s cookie dialog. ' +
        'Please run the login again and accept cookies.'
    );
    this.name = 'SlackSessionCookieMissingError';
  }
}

/**
 * The Slack client loaded, so the user is signed in, but none of its responses
 * carried a session token.
 */
export class SlackTokenMissingError extends LoginFailedError {
  constructor() {
    super(
      'Login failed: the Slack client loaded, but no session token was found in its ' +
        'responses. Please run the login again; if you rejected cookies in Slack\'s ' +
        'cookie dialog, accept them this time.'
    );
    this.name = 'SlackTokenMissingError';
  }
}

async function readDCookieFromJar(page: Page): Promise<string | null> {
  const cookies = await page.context().cookies();
  const dCookie = cookies.find(
    (cookie) => cookie.name === 'd' && /(^|\.)slack\.com$/.test(cookie.domain)
  );
  return dCookie?.value ?? null;
}

/**
 * Whether the browser sits on a fully loaded Slack client. Loading counts
 * subresources too, so on a slow connection this simply takes longer to become
 * true. A page mid-navigation cannot be asked and counts as not loaded.
 */
async function isSlackClientLoaded(page: Page): Promise<boolean> {
  if (!SLACK_CLIENT_URL_PATTERN.test(page.url())) {
    return false;
  }
  try {
    const readyState: unknown = await page.evaluate('document.readyState');
    return readyState === 'complete';
  } catch {
    return false;
  }
}

class SlackServiceSession extends SimpleServiceSession {
  /** Token seen in a response that did not carry the `d` cookie. */
  private pendingToken: string | null = null;

  /** When the Slack client was first seen fully loaded, or null until then. */
  private clientLoadedAt: number | null = null;

  protected async getApiCredentialsFromResponse(
    response: Response
  ): Promise<ApiCredentials | null> {
    const request = response.request();
    if (!SLACK_URL_PATTERN.test(request.url())) {
      return null;
    }

    let responseBody: string;
    try {
      responseBody = await response.text();
    } catch {
      // The body is no longer retrievable (a redirect, or a page that has
      // navigated on); other responses get their chance.
      return null;
    }
    const token = API_TOKEN_PATTERN.exec(responseBody)?.[1];
    if (token === undefined) {
      return null;
    }

    this.pendingToken = token;

    const cookieHeader = (await request.allHeaders()).cookie;
    const dCookie =
      cookieHeader === undefined ? undefined : D_COOKIE_HEADER_PATTERN.exec(cookieHeader)?.[1];
    return dCookie === undefined ? null : new SlackApiCredentials(token, dCookie);
  }

  /**
   * Notice a login that is stuck: Slack has signed the user in, yet the two
   * things the credentials are made of have not both turned up.
   *
   * A token whose request did not carry the `d` cookie is paired with the
   * cookie from the browser's jar. If the jar has none either, the login is
   * given up on at once: the cookie is set at sign-in, before Slack serves
   * anything containing a token, so it is not still coming.
   *
   * Without a token, the login is given up on once the client has finished
   * loading and has then had ample time to make its own requests without any
   * of them carrying one.
   */
  override async whileWaitingForLogin(page: Page): Promise<void> {
    if (this.apiCredentials !== null) {
      return;
    }

    if (this.pendingToken !== null) {
      const dCookie = await readDCookieFromJar(page);
      if (dCookie === null) {
        throw new SlackSessionCookieMissingError();
      }
      this.apiCredentials = new SlackApiCredentials(this.pendingToken, dCookie);
      return;
    }

    if (this.clientLoadedAt === null) {
      if (await isSlackClientLoaded(page)) {
        this.clientLoadedAt = Date.now();
      }
      return;
    }
    if (Date.now() - this.clientLoadedAt >= TOKEN_SETTLE_PERIOD_MS) {
      throw new SlackTokenMissingError();
    }
  }
}

export class Slack extends Service {
  readonly name = 'slack';
  readonly displayName = 'Slack';
  readonly baseApiUrls = ['https://slack.com/api/', 'https://files.slack.com/'] as const;
  readonly loginUrl = 'https://slack.com/signin';
  readonly info =
    'https://docs.slack.dev/apis/web-api/. ' +
    'Credentials are extracted from the user session, not a bot token.';

  readonly credentialCheckCurlArguments = ['https://slack.com/api/auth.test'] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer xoxb-your-token"`;
  }

  override getSession(appNamePrefix: string): SlackServiceSession {
    return new SlackServiceSession(this, appNamePrefix);
  }

  // auth.test reports authentication failures as HTTP 200 with `ok: false`,
  // so validity comes from the body rather than the status code.
  protected override isCredentialCheckResponseValid(
    _httpStatusCode: string,
    responseBody: string
  ): boolean {
    const data = tryParseJson(responseBody) as { ok?: boolean } | null;
    return data?.ok === true;
  }

  override getAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    return fetchAccountFromEndpoint(
      apiCredentials,
      this.credentialCheckCurlArguments,
      (responseBody) => {
        const data = tryParseJson(responseBody) as {
          user?: string;
          team?: string;
          url?: string;
        } | null;
        if (data?.user === undefined) {
          return null;
        }
        // The same user can be signed in to several workspaces, so the account
        // includes the workspace: prefer the stable subdomain from the workspace
        // URL, falling back to the display name.
        const workspaceMatch =
          data.url === undefined ? null : /^https:\/\/([^./]+)\./.exec(data.url);
        const workspace = workspaceMatch?.[1] ?? data.team;
        return workspace === undefined ? data.user : `${data.user}@${workspace}`;
      }
    );
  }
}

export const SLACK = new Slack();
