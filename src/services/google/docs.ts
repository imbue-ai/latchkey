import { GoogleService, type GoogleServiceConfig } from './base.js';

const CONFIG: GoogleServiceConfig = {
  api: 'docs.googleapis.com',
  scopes: ['https://www.googleapis.com/auth/documents'],
};

export class GoogleDocs extends GoogleService {
  readonly name = 'google-docs';
  readonly displayName = 'Google Docs';
  readonly baseApiUrls = ['https://docs.googleapis.com/'] as const;
  readonly info =
    'https://developers.google.com/docs/api/reference/rest. ' +
    'If needed, run "latchkey auth browser-prepare google-docs" to create an OAuth client first. ' +
    'It may take a few minutes before the OAuth client is ready to use.';

  readonly credentialCheckCurlArguments = [
    'https://www.googleapis.com/oauth2/v1/userinfo',
  ] as const;

  protected readonly config = CONFIG;
}

export const GOOGLE_DOCS = new GoogleDocs();
