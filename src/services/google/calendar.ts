import { GoogleService, type GoogleServiceConfig } from './base.js';

const CONFIG: GoogleServiceConfig = {
  api: 'calendar-json.googleapis.com',
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
    'It may take a few minutes before the OAuth client is ready to use.';

  readonly credentialCheckCurlArguments = [
    'https://www.googleapis.com/calendar/v3/calendars/primary',
  ] as const;

  protected readonly config = CONFIG;
}

export const GOOGLE_CALENDAR = new GoogleCalendar();
