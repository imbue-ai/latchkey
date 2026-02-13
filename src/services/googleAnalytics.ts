import { Service } from './base.js';

export class GoogleAnalytics extends Service {
  readonly name = 'google-analytics';
  readonly displayName = 'Google Analytics';
  readonly baseApiUrls = [
    'https://analyticsdata.googleapis.com/',
    'https://analyticsadmin.googleapis.com/',
  ] as const;
  readonly loginUrl = 'https://analytics.google.com/';
  readonly info =
    'https://developers.google.com/analytics/devguides/reporting/data/v1. ' +
    'Browser-based authentication is not supported. ' +
    'Use `latchkey auth set google-analytics -H "Authorization: Bearer <token>"` to add credentials manually. ' +
    'Obtain an OAuth 2.0 access token via the Google Cloud Console at https://console.cloud.google.com/.';

  readonly credentialCheckCurlArguments = [
    'https://analyticsadmin.googleapis.com/v1beta/accountSummaries',
  ] as const;
}

export const GOOGLE_ANALYTICS = new GoogleAnalytics();
