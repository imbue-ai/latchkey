/**
 * Mailchimp service implementation.
 *
 * This service does not support browser flows. Users must manually obtain
 * an API key from https://mailchimp.com/help/about-api-keys/ and use
 * `latchkey insert-auth` to add credentials.
 */

import { Service } from './base.js';

export class Mailchimp extends Service {
  readonly name = 'mailchimp';
  readonly displayName = 'Mailchimp';
  readonly baseApiUrls = ['https://api.mailchimp.com/', 'https://*.api.mailchimp.com/'] as const;
  readonly loginUrl = 'https://login.mailchimp.com/';
  readonly info =
    'https://mailchimp.com/developer/marketing/api/. ' +
    'Browser login is not supported. ' +
    'Use `latchkey insert-auth mailchimp -H "Authorization: Bearer <token>"` to add credentials manually.';

  readonly credentialCheckCurlArguments = ['https://login.mailchimp.com/oauth2/metadata'] as const;

  // Note: getSession() is intentionally not implemented.
  // This service does not support browser-based login flows.
}

export const MAILCHIMP = new Mailchimp();
