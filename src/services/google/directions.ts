import type { ApiCredentials } from '../../apiCredentials.js';
import { Service, NoCurlCredentialsNotSupportedError } from '../core/base.js';
import { GoogleApiKeyCredentials } from './base.js';

export class GoogleDirections extends Service {
  readonly name = 'google-directions';
  readonly displayName = 'Google Directions';
  readonly baseApiUrls = ['https://routes.googleapis.com/'] as const;
  readonly loginUrl = 'https://console.cloud.google.com/google/maps-apis/';
  readonly info =
    'https://developers.google.com/maps/documentation/routes/reference/rest. ' +
    'Example invocation: `latchkey curl google-directions -X POST ' +
    '-H "Content-Type: application/json" ' +
    '-H "X-Goog-FieldMask: routes.duration,routes.distanceMeters" ' +
    '-d \'{"origin":{"address":"New York"},"destination":{"address":"Boston"},"travelMode":"DRIVE"}\' ' +
    'https://routes.googleapis.com/directions/v2:computeRoutes` ' +
    '(the API key will be added automatically).';

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

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set-nocurl ${serviceName} <api-key>`;
  }

  override getCredentialsNoCurl(arguments_: readonly string[]): ApiCredentials {
    if (arguments_.length !== 1 || arguments_[0] === undefined) {
      throw new GoogleDirectionsCredentialError(
        'Expected exactly one argument: the API key.\n' +
          'Example: latchkey auth set-nocurl google-directions <api-key>'
      );
    }
    const apiKey = arguments_[0];
    if (apiKey.length < 10) {
      throw new GoogleDirectionsCredentialError(
        "The provided key doesn't look like a Google API key (too short).\n" + 'Example: <api-key>'
      );
    }
    return new GoogleApiKeyCredentials(apiKey);
  }
}

class GoogleDirectionsCredentialError extends NoCurlCredentialsNotSupportedError {
  constructor(message: string) {
    super('google-directions');
    this.message = message;
    this.name = 'GoogleDirectionsCredentialError';
  }
}

export const GOOGLE_DIRECTIONS = new GoogleDirections();
