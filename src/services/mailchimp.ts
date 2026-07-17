import { Service, tryParseJson } from './core/base.js';

export class Mailchimp extends Service {
  readonly name = 'mailchimp';
  readonly displayName = 'Mailchimp';
  readonly baseApiUrls = [
    'https://api.mailchimp.com/',
    /^https:\/\/[^/]+\.api\.mailchimp\.com\//,
  ] as const;
  readonly loginUrl = 'https://login.mailchimp.com/';
  readonly info = 'https://mailchimp.com/developer/marketing/api/.';

  readonly credentialCheckCurlArguments = ['https://login.mailchimp.com/oauth2/metadata'] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
  }

  protected override parseAccountFromCredentialCheckBody(responseBody: string): string | null {
    const data = tryParseJson(responseBody) as {
      login?: { email?: string; login_email?: string };
      accountname?: string;
    } | null;
    return data?.login?.email ?? data?.login?.login_email ?? data?.accountname ?? null;
  }
}

export const MAILCHIMP = new Mailchimp();
