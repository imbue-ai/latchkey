import { GoogleService, type GoogleServiceConfig } from './base.js';

const CONFIG: GoogleServiceConfig = {
  apis: ['people.googleapis.com'],
  scopes: [
    'https://www.googleapis.com/auth/contacts',
    'https://www.googleapis.com/auth/contacts.readonly',
  ],
};

export class GooglePeople extends GoogleService {
  readonly name = 'google-people';
  readonly displayName = 'Google People';
  readonly baseApiUrls = ['https://people.googleapis.com/'] as const;
  readonly info =
    'https://developers.google.com/people/api/rest. ' +
    'If needed, run "latchkey auth browser-prepare google-people" to create an OAuth client first. ' +
    'It may take a few minutes before the OAuth client is ready to use. ' +
    'Requests that end with `ACCESS_TOKEN_SCOPE_INSUFFICIENT` may be caused by some scopes not having been approved during login. ' +
    'Logging in again and approving all the scopes might help in that case.';

  protected readonly config = CONFIG;
}

export const GOOGLE_PEOPLE = new GooglePeople();
