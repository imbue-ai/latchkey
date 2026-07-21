import type { ApiCredentials } from '../apiCredentials/base.js';
import { fetchAccountFromEndpoint, tryParseJson } from '../apiCredentials/account.js';
import { Service } from './core/base.js';

export class Zoom extends Service {
  readonly name = 'zoom';
  readonly displayName = 'Zoom';
  readonly baseApiUrls = ['https://api.zoom.us/v2/'] as const;
  readonly loginUrl = 'https://zoom.us/signin';
  readonly info = 'https://developers.zoom.us/docs/api/.';

  readonly credentialCheckCurlArguments = [
    '-H',
    'Content-Type: application/json',
    'https://api.zoom.us/v2/users?page_size=1',
  ] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
  }

  /**
   * The account comes from /users/me rather than the user-list endpoint used
   * by the credential check, which carries no identity. Server-to-server
   * tokens have no user context and error on /users/me, in which case the
   * account stays undetermined.
   */
  override getAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    return fetchAccountFromEndpoint(
      apiCredentials,
      ['https://api.zoom.us/v2/users/me'],
      (responseBody) => {
        const data = tryParseJson(responseBody) as {
          email?: string;
          id?: string;
          code?: number;
        } | null;
        if (data === null || data.code !== undefined) {
          return null;
        }
        return data.email ?? data.id ?? null;
      }
    );
  }
}

export const ZOOM = new Zoom();
