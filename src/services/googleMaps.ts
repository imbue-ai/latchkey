import { Service } from './base.js';

export class GoogleMaps extends Service {
  readonly name = 'google-maps';
  readonly displayName = 'Google Maps';
  readonly baseApiUrls = ['https://maps.googleapis.com/'] as const;
  readonly loginUrl = 'https://console.cloud.google.com/google/maps-apis/';
  readonly info =
    'https://developers.google.com/maps/documentation. ' +
    'Browser-based authentication is not yet supported. ' +
    'Use `latchkey auth set google-maps -H "X-Goog-Api-Key: <key>"` to add credentials manually. ' +
    'Only a subset of the APIs accept API keys in the header.';

  readonly credentialCheckCurlArguments = [
    'https://maps.googleapis.com/maps/api/geocode/json?address=test',
  ] as const;
}

export const GOOGLE_MAPS = new GoogleMaps();
