import { describe, it, expect, vi, afterEach } from 'vitest';
import { EncryptedStorage } from '../src/encryptedStorage.js';
import { OAuthCredentials } from '../src/apiCredentials/base.js';
import { GOOGLE_GMAIL } from '../src/services/google/gmail.js';
import type { GoogleServiceConfig } from '../src/services/google/base.js';
import { ScopesNotGrantedError } from '../src/services/core/base.js';
import * as playwrightUtils from '../src/playwrightUtils.js';
import * as oauthUtils from '../src/oauthUtils.js';
import * as curl from '../src/curl.js';

const TEST_ENCRYPTION_KEY = 'dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleXRlc3Q=';

// The service's own scopes are a protected implementation detail; the test
// reaches in so it need not duplicate the list.
const GMAIL_SCOPES = (GOOGLE_GMAIL as unknown as { config: GoogleServiceConfig }).config.scopes;

/**
 * Drives a Google login without a browser: the temp browser context and the
 * loopback callback server are stubbed out, and curl answers the token exchange
 * (and the credential check that follows it) with the given token response.
 */
function stubGoogleLogin(tokenResponse: Record<string, unknown>): void {
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
  vi.spyOn(oauthUtils, 'startOAuthCallbackServer').mockResolvedValue({
    port: 12345,
    codePromise: Promise.resolve('auth-code'),
  });
  vi.spyOn(curl, 'runCapturedAsync').mockResolvedValue({
    returncode: 0,
    stdout: JSON.stringify(tokenResponse),
    stderr: '',
  });
}

const FULL_GRANT = {
  access_token: 'access',
  refresh_token: 'refresh',
  expires_in: 3600,
  token_type: 'Bearer',
  scope: [
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/userinfo.email',
    ...GMAIL_SCOPES,
  ].join(' '),
};

const PARTIAL_GRANT = {
  ...FULL_GRANT,
  scope:
    'https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email',
};

function login(tokenResponse: Record<string, unknown>, strict: boolean) {
  stubGoogleLogin(tokenResponse);
  return GOOGLE_GMAIL.getSession('Latchkey-').login(
    new EncryptedStorage(TEST_ENCRYPTION_KEY),
    {},
    OAuthCredentials.prepared('client-id', 'client-secret'),
    { strict }
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Google strict login', () => {
  it('fails a strict login that granted fewer scopes than requested', async () => {
    const error = await login(PARTIAL_GRANT, true).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ScopesNotGrantedError);
    expect((error as ScopesNotGrantedError).scopesNotGranted).toEqual(GMAIL_SCOPES);
    expect((error as Error).message).toContain('Gmail');
  });

  it('stores a partial grant when the login is not strict', async () => {
    const result = await login(PARTIAL_GRANT, false);

    expect(result.credentials).toBeInstanceOf(OAuthCredentials);
    expect((result.credentials as OAuthCredentials).accessToken).toBe('access');
  });

  it('accepts a strict login that granted everything', async () => {
    const result = await login(FULL_GRANT, true);

    expect((result.credentials as OAuthCredentials).accessToken).toBe('access');
  });
});
