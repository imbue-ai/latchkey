import {
  type ApiCredentials,
  ApiCredentialsUsageError,
} from '../apiCredentials/base.js';
import { runCapturedAsync } from '../curl.js';
import { Service, tryParseJson } from './core/base.js';

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
   * The balance endpoint used for the credential check works with restricted
   * keys but carries no identity, so the account is fetched separately from
   * /v1/account — best-effort, because restricted keys may not be allowed to
   * read the account.
   */
  override async determineAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    let curlArguments: readonly string[];
    try {
      curlArguments = await apiCredentials.injectIntoCurlCall([
        '-s',
        'https://api.stripe.com/v1/account',
      ]);
    } catch (error) {
      if (error instanceof ApiCredentialsUsageError) {
        return null;
      }
      throw error;
    }
    const result = await runCapturedAsync(curlArguments, 10);
    const data = tryParseJson(result.stdout) as {
      email?: string | null;
      id?: string;
      error?: unknown;
    } | null;
    if (data === null || data.error !== undefined) {
      return null;
    }
    return data.email ?? data.id ?? null;
  }
}

export const STRIPE = new Stripe();
