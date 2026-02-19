import { Service } from './base.js';

export class Yelp extends Service {
  readonly name = 'yelp';
  readonly displayName = 'Yelp';
  readonly baseApiUrls = ['https://api.yelp.com/'] as const;
  readonly loginUrl = 'https://www.yelp.com/login';
  readonly info =
    'https://docs.developer.yelp.com/reference. ' +
    'Browser-based authentication is not yet supported. ' +
    'Use `latchkey auth set yelp -H "Authorization: Bearer <token>"` to add credentials manually.';

  readonly credentialCheckCurlArguments = [
    'https://api.yelp.com/v3/businesses/search?location=NYC&limit=1',
  ] as const;
}

export const YELP = new Yelp();
