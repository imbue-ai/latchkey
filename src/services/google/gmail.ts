import { GoogleService, type GoogleServiceConfig } from './base.js';

const CONFIG: GoogleServiceConfig = {
  api: 'gmail.googleapis.com',
  scopes: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.send',
  ],
};

export class GoogleGmail extends GoogleService {
  readonly name = 'google-gmail';
  readonly displayName = 'Google Gmail';
  readonly baseApiUrls = ['https://gmail.googleapis.com/'] as const;
  readonly info =
    'https://developers.google.com/gmail/api/reference/rest. ' +
    'If needed, run "latchkey auth browser-prepare google-gmail" to create an OAuth client first. ' +
    'It may take a few minutes before the OAuth client is ready to use.';

  readonly credentialCheckCurlArguments = [
    'https://gmail.googleapis.com/gmail/v1/users/me/profile',
  ] as const;

  protected readonly config = CONFIG;
}

export const GOOGLE_GMAIL = new GoogleGmail();
