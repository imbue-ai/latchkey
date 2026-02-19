/**
 * Slack service implementation.
 */

import type { Response } from 'playwright';
import { z } from 'zod';
import { ApiCredentialStatus, type ApiCredentials } from '../apiCredentials.js';
import { runCaptured } from '../curl.js';
import { Service, SimpleServiceSession } from './base.js';

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

  injectIntoCurlCall(curlArguments: readonly string[]): readonly string[] {
    return [
      '-H',
      `Authorization: Bearer ${this.token}`,
      '-H',
      `Cookie: d=${this.dCookie}`,
      ...curlArguments,
    ];
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
  readonly baseApiUrls = ['https://slack.com/api/'] as const;
  readonly loginUrl = 'https://slack.com/signin';
  readonly info =
    'https://docs.slack.dev/apis/web-api/. ' +
    'Credentials are extracted from the user session, not a bot token.';

  readonly credentialCheckCurlArguments = ['https://slack.com/api/auth.test'] as const;

  override getSession(): SlackServiceSession {
    return new SlackServiceSession(this);
  }

  override checkApiCredentials(apiCredentials: ApiCredentials): ApiCredentialStatus {
    const result = runCaptured(
      apiCredentials.injectIntoCurlCall(['-s', ...this.credentialCheckCurlArguments]),
      10
    );

    try {
      const data = JSON.parse(result.stdout) as { ok?: boolean };
      if (data.ok) {
        return ApiCredentialStatus.Valid;
      }
      return ApiCredentialStatus.Invalid;
    } catch {
      return ApiCredentialStatus.Invalid;
    }
  }
}

export const SLACK = new Slack();
