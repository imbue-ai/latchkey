import { type ApiCredentials, ApiCredentialStatus } from '../apiCredentials/base.js';
import { fetchAccountFromEndpoint } from '../apiCredentials/account.js';
import { type CredentialCheck, Service } from './core/base.js';

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
   * The check first asks /users/me, whose response both proves the token
   * valid and reveals the account. Server-to-server tokens have no user
   * context and error on /users/me, so when that reveals nothing the check
   * falls back to the user-list endpoint (which works for them but carries no
   * identity).
   */
  override async checkApiCredentials(apiCredentials: ApiCredentials): Promise<CredentialCheck> {
    const account = await fetchAccountFromEndpoint(
      apiCredentials,
      ['https://api.zoom.us/v2/users/me'],
      (responseData) => {
        const data = responseData as {
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
    if (account !== null) {
      return { status: ApiCredentialStatus.Valid, account };
    }
    return super.checkApiCredentials(apiCredentials);
  }
}

export const ZOOM = new Zoom();
