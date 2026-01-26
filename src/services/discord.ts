/**
 * Discord service implementation.
 */

import type { Response } from 'playwright';
import { ApiCredentialStatus, ApiCredentials, AuthorizationBare } from '../apiCredentials.js';
import { runCaptured } from '../curl.js';
import { Service, SimpleServiceSession } from './base.js';

class DiscordServiceSession extends SimpleServiceSession {
  protected getApiCredentialsFromResponse(response: Response): ApiCredentials | null {
    const request = response.request();
    const url = request.url();

    if (!url.startsWith('https://discord.com/api/')) {
      return null;
    }

    const headers = request.headers();
    const authorization = headers.authorization;
    if (authorization !== undefined && authorization.trim() !== '') {
      return new AuthorizationBare(authorization);
    }

    return null;
  }
}

export class Discord implements Service {
  readonly name = 'discord';
  readonly baseApiUrls = ['https://discord.com/api/'] as const;
  readonly loginUrl = 'https://discord.com/login';
  readonly loginInstructions = null;

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
