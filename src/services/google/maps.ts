import { z } from 'zod';
import { ApiCredentialStatus, type ApiCredentials } from '../../apiCredentials.js';
import { extractUrlFromCurlArguments, runCaptured } from '../../curl.js';
import { NoCurlCredentialsNotSupportedError, Service } from '../base.js';

/**
 * Google Maps API key credentials.
 * The API key is injected as a `key=` query parameter in the URL.
 */
export const GoogleMapsApiKeyCredentialsSchema = z.object({
  objectType: z.literal('googleMapsApiKey'),
  apiKey: z.string(),
});

export type GoogleMapsApiKeyCredentialsData = z.infer<typeof GoogleMapsApiKeyCredentialsSchema>;

export class GoogleMapsApiKeyCredentials implements ApiCredentials {
  readonly objectType = 'googleMapsApiKey' as const;
  readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  injectIntoCurlCall(curlArguments: readonly string[]): readonly string[] {
    const url = extractUrlFromCurlArguments(curlArguments as string[]);
    if (!url?.startsWith('https://maps.googleapis.com/')) {
      return curlArguments;
    }
    const separator = url.includes('?') ? '&' : '?';
    const rewrittenUrl = `${url}${separator}key=${this.apiKey}`;
    return curlArguments.map((argument) => (argument === url ? rewrittenUrl : argument));
  }

  isExpired(): boolean | undefined {
    return undefined;
  }

  toJSON(): GoogleMapsApiKeyCredentialsData {
    return {
      objectType: this.objectType,
      apiKey: this.apiKey,
    };
  }

  static fromJSON(data: GoogleMapsApiKeyCredentialsData): GoogleMapsApiKeyCredentials {
    return new GoogleMapsApiKeyCredentials(data.apiKey);
  }
}

export class GoogleMaps extends Service {
  readonly name = 'google-maps';
  readonly displayName = 'Google Maps';
  readonly baseApiUrls = ['https://maps.googleapis.com/'] as const;
  readonly loginUrl = 'https://console.cloud.google.com/google/maps-apis/';
  readonly info =
    'https://developers.google.com/maps/documentation. ' +
    'Browser-based authentication is not yet supported. ' +
    'Use `latchkey auth set-nocurl google-maps <api-key>` to add credentials. ' +
    'Example invocation: `latchkey curl google-maps https://maps.googleapis.com/maps/api/geocode/json?address=1600+Amphitheatre+Parkway` ' +
    '(the API key will be added automatically).';

  readonly credentialCheckCurlArguments = [
    'https://maps.googleapis.com/maps/api/geocode/json?address=test',
  ] as const;

  override getCredentialsNoCurl(arguments_: readonly string[]): ApiCredentials {
    if (arguments_.length !== 1 || arguments_[0] === undefined) {
      throw new GoogleMapsCredentialError(
        'Expected exactly one argument: the API key.\n' +
          'Example: latchkey auth set-nocurl google-maps AIzaSyA1B2C3D4E5F6G7H8I9J0'
      );
    }
    const apiKey = arguments_[0];
    if (apiKey.length < 10) {
      throw new GoogleMapsCredentialError(
        "The provided key doesn't look like a Google Maps API key (too short).\n" +
          'Example: AIzaSyA1B2C3D4E5F6G7H8I9J0'
      );
    }
    return new GoogleMapsApiKeyCredentials(apiKey);
  }

  override checkApiCredentials(apiCredentials: ApiCredentials): ApiCredentialStatus {
    const allCurlArgs = apiCredentials.injectIntoCurlCall([
      '-s',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      ...this.credentialCheckCurlArguments,
    ]);

    const result = runCaptured(allCurlArgs, 10);

    if (result.stdout === '200') {
      return ApiCredentialStatus.Valid;
    }
    return ApiCredentialStatus.Invalid;
  }
}

class GoogleMapsCredentialError extends NoCurlCredentialsNotSupportedError {
  constructor(message: string) {
    super('google-maps');
    this.message = message;
    this.name = 'GoogleMapsCredentialError';
  }
}

export const GOOGLE_MAPS = new GoogleMaps();
