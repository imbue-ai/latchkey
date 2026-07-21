import { Service } from './core/base.js';
import { tryParseJson } from '../apiCredentials/account.js';

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

  protected override parseAccountFromCredentialCheckBody(responseBody: string): string | null {
    const data = tryParseJson(responseBody) as { email?: string; handle?: string } | null;
    return data?.email ?? data?.handle ?? null;
  }
}

export const FIGMA = new Figma();
