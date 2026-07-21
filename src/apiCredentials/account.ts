/**
 * Account identifiers for stored credentials, and helpers for determining the
 * account behind a set of credentials.
 *
 * An account is a string that uniquely identifies the account behind a set of
 * credentials (typically an e-mail, sometimes an opaque id). The empty string
 * denotes the "default" account.
 *
 * This module must not import the credential store or any service module, so
 * that service implementations can use it without creating an import cycle
 * (store -> serialization -> service -> core/base -> store).
 */

import { type ApiCredentials, ApiCredentialsUsageError } from './base.js';
import { runCaptured } from '../curl.js';

export const DEFAULT_ACCOUNT = '';

/**
 * Parse a JSON response body, returning null instead of throwing on malformed
 * input. Credential-check bodies come from arbitrary servers, so account
 * parsing must never crash on unexpected content.
 */
export function tryParseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * Fetch the account behind the given credentials from a dedicated endpoint,
 * best-effort: returns null when the credentials cannot be injected or when
 * the parser finds no identity in the response. Used by services whose
 * credential-check endpoint carries no identity but that have a separate
 * endpoint revealing it — a response that reveals the account also proves the
 * credentials valid, so those services try this before the plain check.
 */
export async function fetchAccountFromEndpoint(
  apiCredentials: ApiCredentials,
  accountCurlArguments: readonly string[],
  parseAccount: (responseData: unknown) => string | null
): Promise<string | null> {
  let curlArguments: readonly string[];
  try {
    curlArguments = await apiCredentials.injectIntoCurlCall(['-s', ...accountCurlArguments]);
  } catch (error) {
    if (error instanceof ApiCredentialsUsageError) {
      return null;
    }
    throw error;
  }
  const result = runCaptured(curlArguments, 10);
  return parseAccount(tryParseJson(result.stdout));
}
