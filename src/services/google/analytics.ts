import { GoogleService, type GoogleServiceConfig } from './base.js';

const CONFIG: GoogleServiceConfig = {
  api: 'analyticsdata.googleapis.com',
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
    'If needed, run "latchkey auth browser-prepare google-analytics" to create an OAuth client first. ' +
    'It may take a few minutes before the OAuth client is ready to use.';

  readonly credentialCheckCurlArguments = [
    'https://analyticsadmin.googleapis.com/v1beta/accountSummaries',
  ] as const;

  protected readonly config = CONFIG;
}

export const GOOGLE_ANALYTICS = new GoogleAnalytics();
