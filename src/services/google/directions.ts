import { GoogleService, type GoogleServiceConfig } from './base.js';

const CONFIG: GoogleServiceConfig = {
  api: 'routes.googleapis.com',
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
};

export class GoogleDirections extends GoogleService {
  readonly name = 'google-directions';
  readonly displayName = 'Google Directions';
  readonly baseApiUrls = ['https://routes.googleapis.com/'] as const;
  readonly info =
    'https://developers.google.com/maps/documentation/routes/reference/rest. ' +
    'If needed, run "latchkey auth browser-prepare google-directions" to create an OAuth client first. ' +
    'It may take a few minutes before the OAuth client is ready to use.';

  readonly credentialCheckCurlArguments = [
    '-X',
    'POST',
    '-H',
    'Content-Type: application/json',
    '-H',
    'X-Goog-FieldMask: routes.duration',
    '-d',
    '{"origin":{"location":{"latLng":{"latitude":37.419734,"longitude":-122.0827784}}},"destination":{"location":{"latLng":{"latitude":37.417670,"longitude":-122.079595}}},"travelMode":"DRIVE"}',
    'https://routes.googleapis.com/directions/v2:computeRoutes',
  ] as const;

  protected readonly config = CONFIG;
}

export const GOOGLE_DIRECTIONS = new GoogleDirections();
