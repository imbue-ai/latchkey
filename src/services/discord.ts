/**
 * Discord service implementation.
 */

import type { Response } from 'playwright';
import { ApiCredentialStatus, ApiCredentials, AuthorizationBare } from '../apiCredentials.js';
import { runCaptured } from '../curl.js';
import { Service, SimpleServiceSession } from './base.js';

class DiscordServiceSession extends SimpleServiceSession {
  protected async getApiCredentialsFromResponse(
    response: Response
  ): Promise<ApiCredentials | null> {
    const request = response.request();
    const url = request.url();

    if (!url.startsWith('https://discord.com/api/')) {
      return null;
    }

    // Require 2XX response to ensure the session is valid (not expired)
    const status = response.status();
    if (status < 200 || status >= 300) {
      return null;
    }

    const headers = await request.allHeaders();
    const authorization = headers.authorization;
    if (authorization !== undefined && authorization.trim() !== '') {
      return new AuthorizationBare(authorization);
    }

    return null;
  }
}

export class Discord implements Service {
  readonly name = 'discord';
  readonly displayName = 'Discord';
  readonly baseApiUrls = ['https://discord.com/api/'] as const;
  readonly loginUrl = 'https://discord.com/login';
  readonly info =
    'https://discord.com/developers/docs/reference. ' +
    'Credentials are extracted from the user session, not a bot token.';

  readonly credentialCheckCurlArguments = ['https://discord.com/api/v9/users/@me'] as const;

  getSession(): DiscordServiceSession {
    return new DiscordServiceSession(this);
  }

  checkApiCredentials(apiCredentials: ApiCredentials): ApiCredentialStatus {
    if (!(apiCredentials instanceof AuthorizationBare)) {
      return ApiCredentialStatus.Invalid;
    }

    const result = runCaptured(
      [
        '-s',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        ...apiCredentials.asCurlArguments(),
        ...this.credentialCheckCurlArguments,
      ],
      10
    );

    if (result.stdout === '200') {
      return ApiCredentialStatus.Valid;
    }
    return ApiCredentialStatus.Invalid;
  }
}

export const DISCORD = new Discord();
