import { GoogleService, type GoogleServiceConfig } from './base.js';

const CONFIG: GoogleServiceConfig = {
  apis: ['sheets.googleapis.com', 'drive.googleapis.com'],
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.readonly',
  ],
};

export class GoogleSheets extends GoogleService {
  readonly name = 'google-sheets';
  readonly displayName = 'Google Sheets';
  // Sheets workflows also reach into the Drive files API to find, read, and
  // export spreadsheets, so match that subset of the Drive API too. The
  // routing layer resolves the overlap with Google Drive by preferring
  // whichever matching service has usable credentials.
  readonly baseApiUrls = [
    'https://sheets.googleapis.com/',
    /^https:\/\/www\.googleapis\.com\/drive\/v\d+\/files\b/,
  ] as const;
  readonly info =
    'https://developers.google.com/sheets/api/reference/rest. ' +
    'If needed, run "latchkey auth browser-prepare google-sheets" to create an OAuth client first. ' +
    'It may take a few minutes before the OAuth client is ready to use.';

  readonly credentialCheckCurlArguments = [
    "https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id)&q=mimeType%3D'application/vnd.google-apps.spreadsheet'",
  ] as const;

  protected readonly config = CONFIG;
}

export const GOOGLE_SHEETS = new GoogleSheets();
