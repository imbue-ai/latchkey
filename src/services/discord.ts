/**
 * Discord service implementation.
 */

import type { Response } from 'playwright';
import { ApiCredentials, AuthorizationBare } from '../apiCredentials/base.js';
import { Service, SimpleServiceSession, tryParseJson } from './core/base.js';

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

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bot <token>"`;
  }

  override getSession(appNamePrefix: string): DiscordServiceSession {
    return new DiscordServiceSession(this, appNamePrefix);
  }

  protected override parseAccountFromCredentialCheckBody(responseBody: string): string | null {
    // The e-mail is present for user-session credentials; bot tokens only
    // carry the bot's username.
    const data = tryParseJson(responseBody) as {
      email?: string | null;
      username?: string;
      id?: string;
    } | null;
    return data?.email ?? data?.username ?? data?.id ?? null;
  }
}

export const DISCORD = new Discord();
