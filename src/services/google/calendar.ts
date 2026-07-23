import { GoogleService, type GoogleServiceConfig } from './base.js';

const CONFIG: GoogleServiceConfig = {
  apis: ['calendar-json.googleapis.com'],
  scopes: [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events',
  ],
};

export class GoogleCalendar extends GoogleService {
  readonly name = 'google-calendar';
  readonly displayName = 'Google Calendar';
  readonly baseApiUrls = ['https://www.googleapis.com/calendar/'] as const;
  readonly info =
    'https://developers.google.com/calendar/api/v3/reference. ' +
    'If needed, run "latchkey auth browser-prepare google-calendar" to create an OAuth client first. ' +
    'It may take a few minutes before the OAuth client is ready to use. ' +
    'Requests that end with `ACCESS_TOKEN_SCOPE_INSUFFICIENT` may be caused by some scopes not having been approved during login. ' +
    'Logging in again and approving all the scopes might help in that case.';

  protected readonly config = CONFIG;
}

export const GOOGLE_CALENDAR = new GoogleCalendar();
