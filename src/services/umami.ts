import { Service } from './core/base.js';

export class Umami extends Service {
  readonly name = 'umami';
  readonly displayName = 'Umami';
  readonly baseApiUrls = ['https://api.umami.is/'] as const;
  readonly loginUrl = 'https://cloud.umami.is/login';
  readonly info = 'https://umami.is/docs/api.';

  readonly credentialCheckCurlArguments = ['https://api.umami.is/v1/websites'] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "x-umami-api-key: <api-key>"`;
  }
}

export const UMAMI = new Umami();
