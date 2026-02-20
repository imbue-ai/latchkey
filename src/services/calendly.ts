import { Service } from './base.js';

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
}

export const CALENDLY = new Calendly();
