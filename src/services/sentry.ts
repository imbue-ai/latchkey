import { Service } from './base.js';

export class Sentry extends Service {
  readonly name = 'sentry';
  readonly displayName = 'Sentry';
  readonly baseApiUrls = ['https://sentry.io/api/'] as const;
  readonly loginUrl = 'https://sentry.io/auth/login/';
  readonly info =
    'https://docs.sentry.io/api/. ' +
    'Browser-based authentication is not yet supported. ' +
    'Use `latchkey auth set sentry -H "Authorization: Bearer <token>"` to add credentials manually.';

  readonly credentialCheckCurlArguments = ['https://sentry.io/api/0/'] as const;
}

export const SENTRY = new Sentry();
