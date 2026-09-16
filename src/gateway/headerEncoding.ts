/**
 * Recovering the original text of HTTP header values.
 *
 * Node's HTTP parser hands header values back as latin-1: each byte on the
 * wire becomes one character, so a UTF-8 value arrives mojibake'd (an account
 * named `Jane’s Space` reads as `Janeâs Space`). Clients send
 * UTF-8 — curl writes the bytes of its argument verbatim — so the gateway has
 * to undo that decoding before comparing a value against anything it holds as
 * real text, such as a stored account or the configured password.
 */

/**
 * Re-interpret a header value that Node decoded as latin-1 as the UTF-8 it
 * almost certainly was.
 *
 * The conversion is applied only when it round-trips: re-encoding the result
 * must reproduce the exact bytes received. That leaves a pure-ASCII value
 * untouched (ASCII is its own UTF-8), and leaves a value whose bytes are not
 * valid UTF-8 exactly as received rather than replacing the offending bytes
 * with U+FFFD.
 */
export function decodeHeaderValue(value: string): string {
  const bytes = Buffer.from(value, 'latin1');
  const decoded = bytes.toString('utf8');
  return Buffer.from(decoded, 'utf8').equals(bytes) ? decoded : value;
}
