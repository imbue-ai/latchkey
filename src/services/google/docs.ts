import { GoogleService, type GoogleServiceConfig } from './base.js';

const CONFIG: GoogleServiceConfig = {
  apis: ['docs.googleapis.com', 'drive.googleapis.com'],
  scopes: [
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/drive.readonly',
  ],
};

export class GoogleDocs extends GoogleService {
  readonly name = 'google-docs';
  readonly displayName = 'Google Docs';
  // Docs workflows also reach into the Drive files API to find, read, and
  // export documents, so match that subset of the Drive API too. The routing
  // layer resolves the overlap with Google Drive by preferring whichever
  // matching service has usable credentials.
  readonly baseApiUrls = [
    'https://docs.googleapis.com/',
    /^https:\/\/www\.googleapis\.com\/drive\/v\d+\/files\b/,
  ] as const;
  readonly info =
    'https://developers.google.com/docs/api/reference/rest. ' +
    'If needed, run "latchkey auth browser-prepare google-docs" to create an OAuth client first. ' +
    'It may take a few minutes before the OAuth client is ready to use. ' +
    'Requests that end with `ACCESS_TOKEN_SCOPE_INSUFFICIENT` may be caused by some scopes not having been approved during login. ' +
    'Logging in again and approving all the scopes might help in that case.';

  protected readonly config = CONFIG;
}

export const GOOGLE_DOCS = new GoogleDocs();
