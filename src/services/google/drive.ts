import { GoogleService, type GoogleServiceConfig } from './base.js';

const CONFIG: GoogleServiceConfig = {
  apis: ['drive.googleapis.com'],
  scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/drive.file'],
};

export class GoogleDrive extends GoogleService {
  readonly name = 'google-drive';
  readonly displayName = 'Google Drive';
  // Drive hands out a file's exports, and an older revision's only, as
  // `exportLinks` on docs.google.com, which take the same bearer token. Only
  // those export paths are matched, not the rest of docs.google.com.
  readonly baseApiUrls = [
    'https://www.googleapis.com/drive/',
    'https://www.googleapis.com/upload/drive/',
    /^https:\/\/docs\.google\.com\/(?:feeds\/download\/(?:documents\/export|presentations)\/Export|spreadsheets\/export)\?/,
  ] as const;
  readonly info =
    'https://developers.google.com/drive/api/reference/rest/v3. ' +
    'If needed, run "latchkey auth browser-prepare google-drive" to create an OAuth client first. ' +
    'It may take a few minutes before the OAuth client is ready to use. ' +
    'Requests that end with `ACCESS_TOKEN_SCOPE_INSUFFICIENT` may be caused by some scopes not having been approved during login. ' +
    'Logging in again and approving all the scopes might help in that case.';

  protected readonly config = CONFIG;
}

export const GOOGLE_DRIVE = new GoogleDrive();
