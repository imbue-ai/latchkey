import { Service } from './base.js';

export class Yelp extends Service {
  readonly name = 'yelp';
  readonly displayName = 'Yelp';
  readonly baseApiUrls = ['https://api.yelp.com/'] as const;
  readonly loginUrl = 'https://www.yelp.com/login';
  readonly info =
    'https://docs.developer.yelp.com/reference. ' +
    'Browser-based authentication is not supported. ' +
    'Use `latchkey auth set yelp -H "Authorization: Bearer <token>"` to add credentials manually. ' +
    'Create an API key at https://www.yelp.com/developers/v3/manage_app.';

  readonly credentialCheckCurlArguments = [
    'https://api.yelp.com/v3/businesses/search?location=NYC&limit=1',
  ] as const;
}

export const YELP = new Yelp();
