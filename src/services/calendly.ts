import { Service } from './base.js';

export class Calendly extends Service {
  readonly name = 'calendly';
  readonly displayName = 'Calendly';
  readonly baseApiUrls = ['https://api.calendly.com/'] as const;
  readonly loginUrl = 'https://calendly.com/login';
  readonly info =
    'https://developer.calendly.com/api-docs. ' +
    'Browser-based authentication is not yet supported. ' +
    'Use `latchkey auth set calendly -H "Authorization: Bearer <token>"` to add credentials manually.';

  readonly credentialCheckCurlArguments = [
    '-H',
    'Content-Type: application/json',
    'https://api.calendly.com/users/me',
  ] as const;
}

export const CALENDLY = new Calendly();
