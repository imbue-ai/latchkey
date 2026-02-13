import { Service } from './base.js';

export class GoogleMaps extends Service {
  readonly name = 'google-maps';
  readonly displayName = 'Google Maps';
  readonly baseApiUrls = ['https://maps.googleapis.com/'] as const;
  readonly loginUrl = 'https://console.cloud.google.com/google/maps-apis/';
  readonly info =
    'https://developers.google.com/maps/documentation. ' +
    'Browser-based authentication is not supported. ' +
    'Google Maps uses API key authentication via a query parameter, not headers. ' +
    'Use `latchkey auth set google-maps -H "X-Goog-Api-Key: <key>"` to add credentials manually. ' +
    'Create an API key at https://console.cloud.google.com/google/maps-apis/credentials.';

  readonly credentialCheckCurlArguments = [
    'https://maps.googleapis.com/maps/api/geocode/json?address=test',
  ] as const;
}

export const GOOGLE_MAPS = new GoogleMaps();
