/**
 * Shared definitions for the optional gateway password used to authenticate
 * requests between the latchkey CLI (in gateway mode) and the `latchkey
 * gateway` server.
 */

import { timingSafeEqual } from 'node:crypto';

/**
 * HTTP header used to carry the shared secret. Lowercased to match how
 * Node's `http.IncomingMessage.headers` exposes header names.
 */
export const GATEWAY_PASSWORD_HEADER = 'x-latchkey-gateway-password';

/**
 * Compare two passwords in constant time relative to their length.
 * Returns false when the values differ in length or contents.
 */
export function passwordsMatch(expected: string, provided: string): boolean {
  const expectedBytes = Buffer.from(expected, 'utf-8');
  const providedBytes = Buffer.from(provided, 'utf-8');
  if (expectedBytes.length !== providedBytes.length) {
    return false;
  }
  return timingSafeEqual(expectedBytes, providedBytes);
}
