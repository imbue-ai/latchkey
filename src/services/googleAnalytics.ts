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
    'Browser-based authentication is not yet supported. ' +
    'Use `latchkey auth set google-analytics -H "Authorization: Bearer <token>"` to add credentials manually.';

  readonly credentialCheckCurlArguments = [
    'https://analyticsadmin.googleapis.com/v1beta/accountSummaries',
  ] as const;
}

export const GOOGLE_ANALYTICS = new GoogleAnalytics();
