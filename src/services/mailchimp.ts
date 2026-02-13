import { Service } from './base.js';

export class Mailchimp extends Service {
  readonly name = 'mailchimp';
  readonly displayName = 'Mailchimp';
  readonly baseApiUrls = [
    'https://api.mailchimp.com/',
    /^https:\/\/[^/]+\.api\.mailchimp\.com\//,
  ] as const;
  readonly loginUrl = 'https://login.mailchimp.com/';
  readonly info =
    'https://mailchimp.com/developer/marketing/api/. ' +
    'Browser-based authentication is not supported. ' +
    'Use `latchkey auth set mailchimp -H "Authorization: Bearer <token>"` to add credentials manually.';

  readonly credentialCheckCurlArguments = ['https://login.mailchimp.com/oauth2/metadata'] as const;
}

export const MAILCHIMP = new Mailchimp();
