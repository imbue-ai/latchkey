/**
 * Tests for recovering UTF-8 header values out of Node's latin-1 rendering.
 */

import { describe, expect, it } from 'vitest';
import { decodeHeaderValue } from '../src/gateway/headerEncoding.js';

/**
 * How a value sent as UTF-8 bytes on the wire reaches a Node HTTP handler:
 * one character per byte.
 */
function asNodeWouldDecodeIt(value: string): string {
  return Buffer.from(value, 'utf8').toString('latin1');
}

describe('decodeHeaderValue', () => {
  it('recovers a non-ASCII value', () => {
    const original = 'jane@example.com:Jane’s Space';
    expect(asNodeWouldDecodeIt(original)).not.toBe(original);
    expect(decodeHeaderValue(asNodeWouldDecodeIt(original))).toBe(original);
  });

  it('leaves ASCII untouched', () => {
    for (const value of ['jane@example.com', '', 'Bearer abc.123-_~/+=', 'a b c']) {
      expect(decodeHeaderValue(value)).toBe(value);
    }
  });

  it('round-trips every kind of non-ASCII text', () => {
    for (const value of ['Café', 'Ünïcödé', '日本語', '🔑 key', 'Jane’s “Space”']) {
      expect(decodeHeaderValue(asNodeWouldDecodeIt(value))).toBe(value);
    }
  });

  it('leaves bytes that are not valid UTF-8 exactly as received', () => {
    // A lone 0xFF never appears in UTF-8. Decoding must not replace it with
    // U+FFFD, which would silently corrupt the value instead of preserving it.
    const received = Buffer.from([0x61, 0xff, 0x62]).toString('latin1');
    expect(decodeHeaderValue(received)).toBe(received);
  });

  it('is idempotent on already-decoded ASCII', () => {
    const once = decodeHeaderValue('plain-value');
    expect(decodeHeaderValue(once)).toBe(once);
  });
});
