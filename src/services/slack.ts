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
 * How long a signed-in browser is given to yield both halves of the credentials
 * before the login is given up on with an explanation, rather than left waiting
 * for something that is not going to happen.
 */
const SIGNED_IN_GRACE_PERIOD_MS = 10_000;

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

class SlackServiceSession extends SimpleServiceSession {
  /** Token seen in a response that did not carry the `d` cookie. */
  private pendingToken: string | null = null;

  /** When the browser was first seen to be signed in, or null until then. */
  private signedInSince: number | null = null;

  private noteSignedIn(): void {
    this.signedInSince ??= Date.now();
  }

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

    // A token means Slack has signed the user in, whether or not the cookie is
    // there to go with it.
    this.noteSignedIn();
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
   * A token whose request did not carry the `d` cookie is first paired with the
   * cookie from the browser's jar, if it is there. Only when the browser has
   * been signed in for a while and the credentials are still incomplete is the
   * login abandoned, with the missing half named.
   */
  override async whileWaitingForLogin(page: Page): Promise<void> {
    if (this.apiCredentials !== null) {
      return;
    }
    if (SLACK_CLIENT_URL_PATTERN.test(page.url())) {
      this.noteSignedIn();
    }
    if (this.signedInSince === null) {
      return;
    }

    if (this.pendingToken !== null) {
      const dCookie = await readDCookieFromJar(page);
      if (dCookie !== null) {
        this.apiCredentials = new SlackApiCredentials(this.pendingToken, dCookie);
        return;
      }
    }

    if (Date.now() - this.signedInSince < SIGNED_IN_GRACE_PERIOD_MS) {
      return;
    }
    throw this.pendingToken === null
      ? new SlackTokenMissingError()
      : new SlackSessionCookieMissingError();
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
