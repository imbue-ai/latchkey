/**
 * Slack service implementation.
 */

import type { Response } from 'playwright';
import { z } from 'zod';
import type { ApiCredentials } from '../apiCredentials/base.js';
import { Service, SimpleServiceSession } from './core/base.js';
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

class SlackServiceSession extends SimpleServiceSession {
  private pendingDCookie: string | null = null;

  protected async getApiCredentialsFromResponse(
    response: Response
  ): Promise<ApiCredentials | null> {
    const request = response.request();
    const url = request.url();

    // Check if the domain is under slack.com
    if (!/^https:\/\/([a-z0-9-]+\.)?slack\.com\//.test(url)) {
      return null;
    }

    const headers = await request.allHeaders();
    const cookieHeader = headers.cookie;
    if (cookieHeader === undefined) {
      return null;
    }

    const cookieMatch = /\bd=([^;]+)/.exec(cookieHeader);
    if (!cookieMatch?.[1]) {
      return null;
    }
    const dCookie = cookieMatch[1];
    this.pendingDCookie = dCookie;

    // Extract token from response body (JSON embedded in HTML or raw JSON)
    try {
      const responseBody = await response.text();
      const tokenMatch = /"api_token":"(xoxc-[a-zA-Z0-9-]+)"/.exec(responseBody);
      if (tokenMatch?.[1]) {
        return new SlackApiCredentials(tokenMatch[1], dCookie);
      }
    } catch {
      // Ignore errors reading response body
    }

    return null;
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
