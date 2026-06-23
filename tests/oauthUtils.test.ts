import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  startOAuthCallbackServer,
  generateCodeVerifier,
  generateCodeChallenge,
  exchangeCodeForTokens,
  refreshAccessToken,
  OAuthTokenExchangeError,
  OAuthCallbackServerTimeoutError,
} from '../src/oauthUtils.js';
import * as curl from '../src/curl.js';

afterEach(() => {
  vi.restoreAllMocks();
});

void startOAuthCallbackServer;
void OAuthTokenExchangeError;
void OAuthCallbackServerTimeoutError;

describe('startOAuthCallbackServer', () => {
  it.todo('add tests');
});

describe('generateCodeVerifier', () => {
  it('produces a URL-safe base64 verifier with no padding', () => {
    // 32 random bytes base64url-encoded -> 43 chars, [A-Za-z0-9_-], no '='.
    const verifier = generateCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier).toHaveLength(43);
  });

  it('returns a different value on each call', () => {
    expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
  });
});

describe('generateCodeChallenge', () => {
  it('derives the S256 challenge from the RFC 7636 test vector', () => {
    // RFC 7636 Appendix B known-answer pair.
    expect(generateCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    );
  });

  it('produces a URL-safe base64 challenge with no padding', () => {
    const challenge = generateCodeChallenge(generateCodeVerifier());
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('exchangeCodeForTokens', () => {
  it('with PKCE: includes code_verifier in body', () => {
    const spy = vi.spyOn(curl, 'runCaptured').mockImplementation(() => {
      throw new Error('STOP');
    });

    expect(() =>
      exchangeCodeForTokens(
        'https://api.notion.com/v1/oauth/token',
        'auth-code-abc123',
        'test-client-id',
        'test-client-secret',
        'http://localhost:12345/oauth2callback',
        'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
      )
    ).toThrow('STOP');

    const args = spy.mock.calls[0]![0];
    const body = args[args.indexOf('-d') + 1]!;
    expect(body).toBe(
      'code=auth-code-abc123&client_id=test-client-id&redirect_uri=http%3A%2F%2Flocalhost%3A12345%2Foauth2callback&grant_type=authorization_code&client_secret=test-client-secret&code_verifier=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    );
  });

  it('without PKCE: omits code_verifier from body', () => {
    const spy = vi.spyOn(curl, 'runCaptured').mockImplementation(() => {
      throw new Error('STOP');
    });

    expect(() =>
      exchangeCodeForTokens(
        'https://api.notion.com/v1/oauth/token',
        'auth-code-abc123',
        'test-client-id',
        'test-client-secret',
        'http://localhost:12345/oauth2callback'
      )
    ).toThrow('STOP');

    const args = spy.mock.calls[0]![0];
    const body = args[args.indexOf('-d') + 1]!;
    expect(body).toBe(
      'code=auth-code-abc123&client_id=test-client-id&redirect_uri=http%3A%2F%2Flocalhost%3A12345%2Foauth2callback&grant_type=authorization_code&client_secret=test-client-secret'
    );
  });
});

describe('refreshAccessToken', () => {
  it('confidential client: includes client_secret in body', () => {
    const spy = vi.spyOn(curl, 'runCaptured').mockImplementation(() => {
      throw new Error('STOP');
    });

    expect(() =>
      refreshAccessToken(
        'https://api.notion.com/v1/oauth/token',
        'refresh-token-xyz789',
        'test-client-id',
        'test-client-secret'
      )
    ).toThrow('STOP');

    const args = spy.mock.calls[0]![0];
    const body = args[args.indexOf('-d') + 1]!;
    expect(body).toBe(
      'refresh_token=refresh-token-xyz789&client_id=test-client-id&grant_type=refresh_token&client_secret=test-client-secret'
    );
  });

  it('public client: omits client_secret from body', () => {
    const spy = vi.spyOn(curl, 'runCaptured').mockImplementation(() => {
      throw new Error('STOP');
    });

    expect(() =>
      refreshAccessToken(
        'https://api.notion.com/v1/oauth/token',
        'refresh-token-xyz789',
        'test-client-id',
        ''
      )
    ).toThrow('STOP');

    const args = spy.mock.calls[0]![0];
    const body = args[args.indexOf('-d') + 1]!;
    expect(body).toBe(
      'refresh_token=refresh-token-xyz789&client_id=test-client-id&grant_type=refresh_token'
    );
  });
});
