import type { ApiCredentials } from '../apiCredentials/base.js';
import { Service } from './core/base.js';
import { fetchAccountFromEndpoint, tryParseJson } from '../apiCredentials/account.js';

export class Figma extends Service {
  readonly name = 'figma';
  readonly displayName = 'Figma';
  readonly baseApiUrls = ['https://api.figma.com/'] as const;
  readonly loginUrl = 'https://www.figma.com/login';
  readonly info = 'https://www.figma.com/developers/api.';

  readonly credentialCheckCurlArguments = ['https://api.figma.com/v1/me'] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
  }

  override getAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    return fetchAccountFromEndpoint(
      apiCredentials,
      this.credentialCheckCurlArguments,
      (responseBody) => {
        const data = tryParseJson(responseBody) as { email?: string; handle?: string } | null;
        return data?.email ?? data?.handle ?? null;
      }
    );
  }
}

export const FIGMA = new Figma();
