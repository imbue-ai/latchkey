import { Service } from './core/base.js';
import { tryParseJson } from '../apiCredentials/account.js';

export class Calendly extends Service {
  readonly name = 'calendly';
  readonly displayName = 'Calendly';
  readonly baseApiUrls = ['https://api.calendly.com/'] as const;
  readonly loginUrl = 'https://calendly.com/login';
  readonly info = 'https://developer.calendly.com/api-docs.';

  readonly credentialCheckCurlArguments = [
    '-H',
    'Content-Type: application/json',
    'https://api.calendly.com/users/me',
  ] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
  }

  protected override parseAccountFromCredentialCheckBody(responseBody: string): string | null {
    const data = tryParseJson(responseBody) as {
      resource?: { email?: string; name?: string };
    } | null;
    return data?.resource?.email ?? data?.resource?.name ?? null;
  }
}

export const CALENDLY = new Calendly();
