import { Service } from './base.js';

export class Sentry extends Service {
  readonly name = 'sentry';
  readonly displayName = 'Sentry';
  readonly baseApiUrls = ['https://sentry.io/api/'] as const;
  readonly loginUrl = 'https://sentry.io/auth/login/';
  readonly info =
    'https://docs.sentry.io/api/. ' +
    'Browser-based authentication is not supported. ' +
    'Use `latchkey auth set sentry -H "Authorization: Bearer <token>"` to add credentials manually. ' +
    'Create an auth token at https://sentry.io/settings/auth-tokens/.';

  readonly credentialCheckCurlArguments = ['https://sentry.io/api/0/'] as const;
}

export const SENTRY = new Sentry();
