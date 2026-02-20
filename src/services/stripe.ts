import { Service } from './base.js';

export class Stripe extends Service {
  readonly name = 'stripe';
  readonly displayName = 'Stripe';
  readonly baseApiUrls = ['https://api.stripe.com/'] as const;
  readonly loginUrl = 'https://dashboard.stripe.com/login';
  readonly info = 'https://docs.stripe.com/api.';

  readonly credentialCheckCurlArguments = ['https://api.stripe.com/v1/balance'] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
  }
}

export const STRIPE = new Stripe();
