import { Service } from './base.js';

export class Stripe extends Service {
  readonly name = 'stripe';
  readonly displayName = 'Stripe';
  readonly baseApiUrls = ['https://api.stripe.com/'] as const;
  readonly loginUrl = 'https://dashboard.stripe.com/login';
  readonly info =
    'https://docs.stripe.com/api. ' +
    'Browser-based authentication is not supported. ' +
    'Use `latchkey auth set stripe -H "Authorization: Bearer <token>"` to add credentials manually. ' +
    'Obtain API keys at https://dashboard.stripe.com/apikeys.';

  readonly credentialCheckCurlArguments = ['https://api.stripe.com/v1/balance'] as const;
}

export const STRIPE = new Stripe();
