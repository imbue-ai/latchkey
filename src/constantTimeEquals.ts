import { timingSafeEqual } from 'node:crypto';

/**
 * Whether two secrets are the same, in time that depends on their length
 * only, not on how far into them the first difference lies.
 */
export function equalsInConstantTime(expected: string, provided: string): boolean {
  const expectedBytes = Buffer.from(expected, 'utf-8');
  const providedBytes = Buffer.from(provided, 'utf-8');
  if (expectedBytes.length !== providedBytes.length) {
    return false;
  }
  return timingSafeEqual(expectedBytes, providedBytes);
}
