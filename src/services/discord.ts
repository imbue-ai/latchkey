/**
 * Discord service implementation.
 */

import type { Response } from 'playwright';
import { ApiCredentials, AuthorizationBare } from '../apiCredentials.js';
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

export class Discord extends Service {
  readonly name = 'discord';
  readonly displayName = 'Discord';
  readonly baseApiUrls = ['https://discord.com/api/'] as const;
  readonly loginUrl = 'https://discord.com/login';
  readonly info =
    'https://discord.com/developers/docs/reference. ' +
    'Credentials are extracted from the user session, not a bot token.';

  readonly credentialCheckCurlArguments = ['https://discord.com/api/v9/users/@me'] as const;

  override getSession(): DiscordServiceSession {
    return new DiscordServiceSession(this);
  }
}

export const DISCORD = new Discord();
