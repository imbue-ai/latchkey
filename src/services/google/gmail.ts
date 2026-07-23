import { GoogleService, type GoogleServiceConfig } from './base.js';

const CONFIG: GoogleServiceConfig = {
  apis: ['gmail.googleapis.com'],
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
    'It may take a few minutes before the OAuth client is ready to use. ' +
    'Requests that end with `ACCESS_TOKEN_SCOPE_INSUFFICIENT` may be caused by some scopes not having been approved during login. ' +
    'Logging in again and approving all the scopes might help in that case.';

  protected readonly config = CONFIG;
}

export const GOOGLE_GMAIL = new GoogleGmail();
