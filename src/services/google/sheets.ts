import { GoogleService, type GoogleServiceConfig } from './base.js';

const CONFIG: GoogleServiceConfig = {
  api: 'sheets.googleapis.com',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
};

export class GoogleSheets extends GoogleService {
  readonly name = 'google-sheets';
  readonly displayName = 'Google Sheets';
  readonly baseApiUrls = ['https://sheets.googleapis.com/'] as const;
  readonly info =
    'https://developers.google.com/sheets/api/reference/rest. ' +
    'If needed, run "latchkey auth browser-prepare google-sheets" to create an OAuth client first. ' +
    'It may take a few minutes before the OAuth client is ready to use.';

  readonly credentialCheckCurlArguments = [
    'https://sheets.googleapis.com/v4/spreadsheets?fields=spreadsheetId&pageSize=1',
  ] as const;

  protected readonly config = CONFIG;
}

export const GOOGLE_SHEETS = new GoogleSheets();
