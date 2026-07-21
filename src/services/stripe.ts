import { type ApiCredentials, ApiCredentialStatus } from '../apiCredentials/base.js';
import { fetchAccountFromEndpoint } from '../apiCredentials/account.js';
import { type CredentialCheck, Service } from './core/base.js';

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
   * The check first asks /v1/account, whose response both proves the key
   * valid and reveals the account. Restricted keys may not be allowed to read
   * the account, so when that reveals nothing the check falls back to the
   * balance endpoint (which works with restricted keys but carries no
   * identity).
   */
  override async checkApiCredentials(apiCredentials: ApiCredentials): Promise<CredentialCheck> {
    const account = await fetchAccountFromEndpoint(
      apiCredentials,
      ['https://api.stripe.com/v1/account'],
      (responseData) => {
        const data = responseData as {
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
    if (account !== null) {
      return { status: ApiCredentialStatus.Valid, account };
    }
    return super.checkApiCredentials(apiCredentials);
  }
}

export const STRIPE = new Stripe();
