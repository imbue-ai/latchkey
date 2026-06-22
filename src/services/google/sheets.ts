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
  readonly baseApiUrls = ['https://sheets.googleapis.com/'] as const;
  readonly info =
    'https://developers.google.com/sheets/api/reference/rest. ' +
    'To authenticate, run "latchkey prepare google-sheets" with the official OAuth client id/secret (recommended), ' +
    'or "latchkey auth browser-prepare google-sheets" to create your own client first. ' +
    'It may take a few minutes before the OAuth client is ready to use.';

  readonly credentialCheckCurlArguments = [
    "https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id)&q=mimeType%3D'application/vnd.google-apps.spreadsheet'",
  ] as const;

  protected readonly config = CONFIG;
}

export const GOOGLE_SHEETS = new GoogleSheets();
