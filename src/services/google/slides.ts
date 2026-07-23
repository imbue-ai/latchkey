import { GoogleService, type GoogleServiceConfig } from './base.js';

const CONFIG: GoogleServiceConfig = {
  apis: ['slides.googleapis.com', 'drive.googleapis.com'],
  scopes: [
    'https://www.googleapis.com/auth/presentations',
    'https://www.googleapis.com/auth/drive.readonly',
  ],
};

export class GoogleSlides extends GoogleService {
  readonly name = 'google-slides';
  readonly displayName = 'Google Slides';
  // Slides workflows also reach into the Drive files API to find, read, and
  // export presentations, so match that subset of the Drive API too. The
  // routing layer resolves the overlap with Google Drive by preferring
  // whichever matching service has usable credentials.
  readonly baseApiUrls = [
    'https://slides.googleapis.com/',
    /^https:\/\/www\.googleapis\.com\/drive\/v\d+\/files\b/,
  ] as const;
  readonly info =
    'https://developers.google.com/slides/api/reference/rest. ' +
    'If needed, run "latchkey auth browser-prepare google-slides" to create an OAuth client first. ' +
    'It may take a few minutes before the OAuth client is ready to use. ' +
    'Requests that end with `ACCESS_TOKEN_SCOPE_INSUFFICIENT` may be caused by some scopes not having been approved during login. ' +
    'Logging in again and approving all the scopes might help in that case.';

  protected readonly config = CONFIG;
}

export const GOOGLE_SLIDES = new GoogleSlides();
