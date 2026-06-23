import { describe, it, expect } from 'vitest';
import { isBrowserClosedError, isResponseBodyUnavailableError } from '../src/services/core/base.js';

describe('isResponseBodyUnavailableError', () => {
  it('recognizes the CDP "no resource with given identifier" error', () => {
    const error = new Error(
      'Protocol error (Network.getResponseBody): No resource with given identifier found'
    );
    expect(isResponseBodyUnavailableError(error)).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(
      isResponseBodyUnavailableError(new Error('NO RESOURCE WITH GIVEN IDENTIFIER FOUND'))
    ).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isResponseBodyUnavailableError(new Error('something else went wrong'))).toBe(false);
  });

  it('is distinct from browser-closed errors', () => {
    const bodyError = new Error(
      'Protocol error (Network.getResponseBody): No resource with given identifier found'
    );
    expect(isBrowserClosedError(bodyError)).toBe(false);
  });
});
