import { GoogleService, type GoogleServiceConfig } from './base.js';

const CONFIG: GoogleServiceConfig = {
  apis: ['analyticsdata.googleapis.com', 'analyticsadmin.googleapis.com'],
  scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
};

export class GoogleAnalytics extends GoogleService {
  readonly name = 'google-analytics';
  readonly displayName = 'Google Analytics';
  readonly baseApiUrls = [
    'https://analyticsdata.googleapis.com/',
    'https://analyticsadmin.googleapis.com/',
  ] as const;
  readonly info =
    'https://developers.google.com/analytics/devguides/reporting/data/v1. ' +
    'To authenticate, run "latchkey prepare google-analytics" with the official OAuth client id/secret (recommended), ' +
    'or "latchkey auth browser-prepare google-analytics" to create your own client first. ' +
    'It may take a few minutes before the OAuth client is ready to use.';

  readonly credentialCheckCurlArguments = [
    'https://analyticsadmin.googleapis.com/v1beta/accountSummaries',
  ] as const;

  protected readonly config = CONFIG;
}

export const GOOGLE_ANALYTICS = new GoogleAnalytics();
