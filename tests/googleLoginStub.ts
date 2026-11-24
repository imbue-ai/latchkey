import { vi } from 'vitest';
import * as playwrightUtils from '../src/playwrightUtils.js';
import * as oauthUtils from '../src/oauthUtils.js';
import * as curl from '../src/curl.js';

export const EXPECTED_STATE = 'random-prefix.12345';

/**
 * Drives a Google login without a browser: the temp browser context and the
 * loopback callback server are stubbed out, and curl answers the token exchange
 * (and the credential check that follows it) with the given token response.
 */
export function stubGoogleLogin(tokenResponse: Record<string, unknown>): {
  fakePage: { goto: ReturnType<typeof vi.fn> };
  startOAuthCallbackServer: ReturnType<typeof vi.fn>;
} {
  const fakePage = {
    goto: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
  };
  const fakeContext = {
    newPage: vi.fn().mockResolvedValue(fakePage),
    on: vi.fn(),
    off: vi.fn(),
  };
  vi.spyOn(playwrightUtils, 'withTempBrowserContext').mockImplementation(
    (_storage, _options, callback) =>
      callback({
        browser: {},
        context: fakeContext,
      } as unknown as playwrightUtils.BrowserWithContext)
  );
  const startOAuthCallbackServer = vi
    .spyOn(oauthUtils, 'startOAuthCallbackServer')
    .mockResolvedValue({
      port: 12345,
      codePromise: Promise.resolve('auth-code'),
      state: EXPECTED_STATE,
    });
  vi.spyOn(curl, 'runCapturedAsync').mockResolvedValue({
    returncode: 0,
    stdout: JSON.stringify(tokenResponse),
    stderr: '',
  });
  return { fakePage, startOAuthCallbackServer };
}
