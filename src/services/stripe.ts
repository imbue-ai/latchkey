import type { ApiCredentials } from '../apiCredentials/base.js';
import { fetchAccountFromEndpoint, tryParseJson } from '../apiCredentials/account.js';
import { Service } from './core/base.js';

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

  /**
   * The account comes from /v1/account rather than the balance endpoint used
   * by the credential check, which carries no identity. Restricted keys may
   * not be allowed to read the account, in which case it stays undetermined.
   */
  override getAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    return fetchAccountFromEndpoint(
      apiCredentials,
      ['https://api.stripe.com/v1/account'],
      (responseBody) => {
        const data = tryParseJson(responseBody) as {
          email?: string | null;
          id?: string;
          error?: unknown;
        } | null;
        if (data === null || data.error !== undefined) {
          return null;
        }
        return data.email ?? data.id ?? null;
      }
    );
  }
}

export const STRIPE = new Stripe();
