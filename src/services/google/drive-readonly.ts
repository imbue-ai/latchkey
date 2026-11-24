import { GoogleService, type GoogleServiceConfig } from './base.js';

// `drive.readonly` alone covers reading every Drive file through the Drive,
// Docs, Sheets and Slides APIs, so one OAuth client in one project serves all
// four; preparing it turns all four APIs on.
const CONFIG: GoogleServiceConfig = {
  apis: [
    'drive.googleapis.com',
    'docs.googleapis.com',
    'sheets.googleapis.com',
    'slides.googleapis.com',
  ],
  scopes: ['https://www.googleapis.com/auth/drive.readonly'],
};

export class GoogleDriveReadonly extends GoogleService {
  readonly name = 'google-drive-readonly';
  readonly displayName = 'Google Drive (read-only)';
  // Everything the Drive, Docs, Sheets and Slides services match, minus
  // Drive's upload endpoint, which only takes writes. The routing layer
  // resolves the overlap with those services by preferring whichever matching
  // service has usable credentials.
  readonly baseApiUrls = [
    'https://www.googleapis.com/drive/',
    'https://docs.googleapis.com/',
    'https://sheets.googleapis.com/',
    'https://slides.googleapis.com/',
    /^https:\/\/docs\.google\.com\/(?:feeds\/download\/(?:documents\/export|presentations)\/Export|spreadsheets\/export)\?/,
  ] as const;
  readonly info =
    'Read-only access to Google Drive, including Docs, Sheets and Slides. ' +
    'https://developers.google.com/drive/api/reference/rest/v3, ' +
    'https://developers.google.com/docs/api/reference/rest, ' +
    'https://developers.google.com/sheets/api/reference/rest, ' +
    'https://developers.google.com/slides/api/reference/rest. ' +
    'If needed, run "latchkey auth browser-prepare google-drive-readonly" to create an OAuth client first. ' +
    'It may take a few minutes before the OAuth client is ready to use. ' +
    'Requests that change anything end with `ACCESS_TOKEN_SCOPE_INSUFFICIENT`; ' +
    'use google-drive, google-docs, google-sheets or google-slides for those.';

  protected readonly config = CONFIG;
}

export const GOOGLE_DRIVE_READONLY = new GoogleDriveReadonly();
