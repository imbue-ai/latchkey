import { GoogleService, type GoogleServiceConfig } from './base.js';

const CONFIG: GoogleServiceConfig = {
  apis: ['drive.googleapis.com'],
  scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/drive.file'],
};

export class GoogleDrive extends GoogleService {
  readonly name = 'google-drive';
  readonly displayName = 'Google Drive';
  readonly baseApiUrls = ['https://www.googleapis.com/drive/'] as const;
  readonly info =
    'https://developers.google.com/drive/api/reference/rest/v3. ' +
    'To authenticate, run "latchkey prepare google-drive" with the official OAuth client id/secret (recommended), ' +
    'or "latchkey auth browser-prepare google-drive" to create your own client first. ' +
    'It may take a few minutes before the OAuth client is ready to use.';

  readonly credentialCheckCurlArguments = [
    'https://www.googleapis.com/drive/v3/about?fields=user',
  ] as const;

  protected readonly config = CONFIG;
}

export const GOOGLE_DRIVE = new GoogleDrive();
