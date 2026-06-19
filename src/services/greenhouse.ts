/**
 * Greenhouse service implementation.
 *
 * The Greenhouse Harvest API authenticates with HTTP Basic auth where the API
 * key is the username and the password is blank. The key is long-lived and is
 * created by an admin under Configure -> Dev Center -> API Credential Management,
 * where the accessible endpoints are also chosen per key.
 */

import { ApiCredentials, AuthorizationBare } from '../apiCredentials/base.js';
import { NoCurlCredentialsNotSupportedError, Service } from './core/base.js';

export class Greenhouse extends Service {
  readonly name = 'greenhouse';
  readonly displayName = 'Greenhouse';
  readonly baseApiUrls = ['https://harvest.greenhouse.io/'] as const;
  readonly loginUrl = 'https://app.greenhouse.io/';
  readonly info =
    'https://developers.greenhouse.io/harvest.html. ' +
    'The Harvest API uses HTTP Basic auth with your API key as the username and a blank ' +
    'password. Create a key in Greenhouse under Configure -> Dev Center -> API Credential ' +
    'Management, granting it the endpoint permissions you need (the credential check uses ' +
    'GET /v1/users). Store it with `latchkey auth set-nocurl greenhouse <api-key>`.';

  readonly credentialCheckCurlArguments = ['https://harvest.greenhouse.io/v1/users'] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set-nocurl ${serviceName} <api-key>`;
  }

  override getCredentialsNoCurl(arguments_: readonly string[]): ApiCredentials {
    const apiKey = arguments_[0];
    if (arguments_.length !== 1 || apiKey === undefined || apiKey === '') {
      throw new GreenhouseCredentialError(
        'Expected exactly one argument: the Greenhouse Harvest API key.\n' +
          'Example: latchkey auth set-nocurl greenhouse <api-key>'
      );
    }
    // Harvest uses Basic auth with the key as the username and a blank password,
    // i.e. `Authorization: Basic base64("<key>:")`. Build that header directly
    // rather than relying on the user to remember the trailing colon.
    const basicAuth = Buffer.from(`${apiKey}:`).toString('base64');
    return new AuthorizationBare(`Basic ${basicAuth}`);
  }
}

class GreenhouseCredentialError extends NoCurlCredentialsNotSupportedError {
  constructor(message: string) {
    super('greenhouse');
    this.message = message;
    this.name = 'GreenhouseCredentialError';
  }
}

export const GREENHOUSE = new Greenhouse();
