import { Service } from './core/base.js';

export class Yelp extends Service {
  readonly name = 'yelp';
  readonly displayName = 'Yelp';
  readonly baseApiUrls = ['https://api.yelp.com/'] as const;
  readonly loginUrl = 'https://www.yelp.com/login';
  readonly info = 'https://docs.developer.yelp.com/reference.';

  readonly credentialCheckCurlArguments = [
    'https://api.yelp.com/v3/businesses/search?location=NYC&limit=1',
  ] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
  }
}

export const YELP = new Yelp();
