/**
 * Slack service implementation.
 */

import type { Response } from 'playwright';
import { ApiCredentialStatus, ApiCredentials, SlackApiCredentials } from '../apiCredentials.js';
import { runCaptured } from '../curl.js';
import { Service, SimpleServiceSession } from './base.js';

class SlackServiceSession extends SimpleServiceSession {
  protected getApiCredentialsFromResponse(response: Response): ApiCredentials | null {
    const request = response.request();
    const url = request.url();

    // Check if the domain is under slack.com
    if (!/^https:\/\/([a-z0-9-]+\.)?slack\.com\//.test(url)) {
      return null;
    }

    const headers = request.headers();
    const cookieHeader = headers.cookie;
    if (cookieHeader === undefined) {
      return null;
    }

    const cookieMatch = /\bd=([^;]+)/.exec(cookieHeader);
    if (!cookieMatch?.[1]) {
      return null;
    }
    const dCookie = cookieMatch[1];

    // Extract token from response body (JSON embedded in HTML or raw JSON)
    let responseBody: string;
    try {
      responseBody = response.text().toString();
    } catch {
      return null;
    }

    const tokenMatch = /"api_token":"(xoxc-[a-zA-Z0-9-]+)"/.exec(responseBody);
    if (!tokenMatch?.[1]) {
      return null;
    }
    const token = tokenMatch[1];

    return new SlackApiCredentials(token, dCookie);
  }
}

export class Slack implements Service {
  readonly name = 'slack';
  readonly baseApiUrls = ['https://slack.com/api/'] as const;
  readonly loginUrl = 'https://slack.com/signin';

  readonly loginInstructions = [
    'Accept all cookies if prompted.',
    'Launch Slack in your browser (not the desktop app).',
  ] as const;

  readonly credentialCheckCurlArguments = ['https://slack.com/api/auth.test'] as const;

  getSession(): SlackServiceSession {
    return new SlackServiceSession(this);
  }

  checkApiCredentials(apiCredentials: ApiCredentials): ApiCredentialStatus {
    if (!(apiCredentials instanceof SlackApiCredentials)) {
      return ApiCredentialStatus.Invalid;
    }

    const result = runCaptured(
      ['-s', ...apiCredentials.asCurlArguments(), ...this.credentialCheckCurlArguments],
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
