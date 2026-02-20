import { GoogleService, type GoogleServiceConfig } from './base.js';

const CONFIG: GoogleServiceConfig = {
  api: 'people.googleapis.com',
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
    'It may take a few minutes before the OAuth client is ready to use.';

  readonly credentialCheckCurlArguments = [
    'https://people.googleapis.com/v1/people/me?personFields=names',
  ] as const;

  protected readonly config = CONFIG;
}

export const GOOGLE_PEOPLE = new GooglePeople();
