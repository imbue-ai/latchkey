import dns from 'node:dns/promises';
import http from 'node:http';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildLoopbackRedirectUri,
  buildOAuthCallbackPageHtml,
  startOAuthCallbackServer,
  generateCodeVerifier,
  generateCodeChallenge,
  exchangeCodeForTokens,
  readRedirectUriOverride,
  refreshAccessToken,
  findScopesNotGranted,
} from '../src/oauthUtils.js';
import { AuthorizationBearer, OAuthCredentials } from '../src/apiCredentials/base.js';
import * as curl from '../src/curl.js';

afterEach(() => {
  vi.restoreAllMocks();
});

interface CallbackResponse {
  readonly status: number | undefined;
  readonly contentType: string | undefined;
  readonly body: string;
}

function requestFrom(host: string, port: number, pathWithQuery: string): Promise<CallbackResponse> {
  return new Promise((resolve, reject) => {
    http
      .get({ host, port, path: pathWithQuery }, (response) => {
        let body = '';
        response.setEncoding('utf-8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode,
            contentType: response.headers['content-type'],
            body,
          });
        });
      })
      .on('error', reject);
  });
}

// The server listens on `localhost`, which binds whichever loopback address
// the name resolves to first, while a client may well pick the other family.
// A browser tries both; this does the same.
async function requestCallback(port: number, pathWithQuery: string): Promise<CallbackResponse> {
  const addresses = await dns.lookup('localhost', { all: true });
  let lastError: unknown = new Error('localhost resolved to no address');
  for (const { address } of addresses) {
    try {
      return await requestFrom(address, port, pathWithQuery);
    } catch (error: unknown) {
      lastError = error;
    }
  }
  throw lastError;
}

describe('startOAuthCallbackServer', () => {
  it('resolves the code and answers the browser with a page that says the login is complete', async () => {
    const { port, codePromise } = await startOAuthCallbackServer();

    const response = await requestCallback(port, '/oauth2callback?code=abc123');

    expect(response.status).toBe(200);
    expect(response.contentType).toContain('text/html');
    const body = response.body;
    expect(body).toContain('Login complete');
    expect(body).toContain('close this tab');
    await expect(codePromise).resolves.toBe('abc123');
  });

  it('rejects with the reason the authorization server gave and shows it on the page', async () => {
    const { port, codePromise } = await startOAuthCallbackServer();
    const codeRejection = expect(codePromise).rejects.toThrow(
      'Authorization failed: access_denied (user <said> no)'
    );

    const response = await requestCallback(
      port,
      `/oauth2callback?error=access_denied&error_description=${encodeURIComponent('user <said> no')}`
    );

    expect(response.status).toBe(400);
    const body = response.body;
    expect(body).toContain('Login failed');
    expect(body).toContain('user &lt;said&gt; no');
    expect(body).not.toContain('<said>');
    await codeRejection;
  });

  it('hands out a state carrying its port, for the authorization request', async () => {
    const { port, state } = await startOAuthCallbackServer();

    expect(state.endsWith(`.${port.toString()}`)).toBe(true);
    expect(state.length).toBeGreaterThan(port.toString().length + 20);
  });

  it('without validateState: accepts a callback that carries no state', async () => {
    const { port, codePromise } = await startOAuthCallbackServer();

    const response = await requestCallback(port, '/oauth2callback?code=abc123');

    expect(response.status).toBe(200);
    await expect(codePromise).resolves.toBe('abc123');
  });

  it('with validateState: resolves the code once the callback echoes the state', async () => {
    const { port, codePromise, state } = await startOAuthCallbackServer(undefined, undefined, {
      validateState: true,
    });

    const response = await requestCallback(
      port,
      `/oauth2callback?code=abc123&state=${encodeURIComponent(state)}`
    );

    expect(response.status).toBe(200);
    await expect(codePromise).resolves.toBe('abc123');
  });

  it('with validateState: refuses a callback with a wrong or missing state and keeps waiting', async () => {
    const { port, codePromise, state } = await startOAuthCallbackServer(undefined, undefined, {
      validateState: true,
    });
    let settled = false;
    void codePromise.then(
      () => (settled = true),
      () => (settled = true)
    );

    const forgedCode = await requestCallback(port, '/oauth2callback?code=forged&state=wrong');
    expect(forgedCode.status).toBe(400);
    expect(forgedCode.body).toContain('Login failed');
    expect(forgedCode.body).toContain('expected state');

    const forgedError = await requestCallback(port, '/oauth2callback?error=access_denied');
    expect(forgedError.status).toBe(400);

    const prefixOnly = await requestCallback(
      port,
      `/oauth2callback?code=forged&state=${encodeURIComponent(state.slice(0, -1))}`
    );
    expect(prefixOnly.status).toBe(400);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    const genuine = await requestCallback(
      port,
      `/oauth2callback?code=abc123&state=${encodeURIComponent(state)}`
    );
    expect(genuine.status).toBe(200);
    await expect(codePromise).resolves.toBe('abc123');
  });
});

describe('buildOAuthCallbackPageHtml', () => {
  it('escapes the failure reason', () => {
    const html = buildOAuthCallbackPageHtml({
      succeeded: false,
      reason: `<script>alert("x")</script> & 'more'`,
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;more&#39;'
    );
  });
});

describe('buildLoopbackRedirectUri', () => {
  it('points at the callback path the server listens on by default', () => {
    expect(buildLoopbackRedirectUri(54321)).toBe('http://localhost:54321/oauth2callback');
  });

  it('accepts a service-specific callback path', () => {
    expect(buildLoopbackRedirectUri(54321, '/ramp-callback')).toBe(
      'http://localhost:54321/ramp-callback'
    );
  });
});

describe('readRedirectUriOverride', () => {
  it('reports the redirect URI of prepared OAuth credentials', () => {
    const prepared = new OAuthCredentials(
      'client-id',
      '',
      undefined,
      undefined,
      undefined,
      undefined,
      'https://example.com/oauth-callback/'
    );

    expect(readRedirectUriOverride(prepared)).toBe('https://example.com/oauth-callback/');
  });

  it('reports nothing for OAuth credentials without one', () => {
    expect(readRedirectUriOverride(new OAuthCredentials('client-id', 'secret'))).toBeUndefined();
  });

  it('reports nothing for credentials of another type, or for none at all', () => {
    expect(readRedirectUriOverride(new AuthorizationBearer('token'))).toBeUndefined();
    expect(readRedirectUriOverride()).toBeUndefined();
  });
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
  it('with PKCE: includes code_verifier in body', async () => {
    const spy = vi.spyOn(curl, 'runCapturedAsync').mockImplementation(() => {
      throw new Error('STOP');
    });

    await expect(
      exchangeCodeForTokens(
        'https://api.notion.com/v1/oauth/token',
        'auth-code-abc123',
        'test-client-id',
        'test-client-secret',
        'http://localhost:12345/oauth2callback',
        'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
      )
    ).rejects.toThrow('STOP');

    const args = spy.mock.calls[0]![0];
    const body = args[args.indexOf('-d') + 1]!;
    expect(body).toBe(
      'code=auth-code-abc123&client_id=test-client-id&redirect_uri=http%3A%2F%2Flocalhost%3A12345%2Foauth2callback&grant_type=authorization_code&client_secret=test-client-secret&code_verifier=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    );
  });

  it('without PKCE: omits code_verifier from body', async () => {
    const spy = vi.spyOn(curl, 'runCapturedAsync').mockImplementation(() => {
      throw new Error('STOP');
    });

    await expect(
      exchangeCodeForTokens(
        'https://api.notion.com/v1/oauth/token',
        'auth-code-abc123',
        'test-client-id',
        'test-client-secret',
        'http://localhost:12345/oauth2callback'
      )
    ).rejects.toThrow('STOP');

    const args = spy.mock.calls[0]![0];
    const body = args[args.indexOf('-d') + 1]!;
    expect(body).toBe(
      'code=auth-code-abc123&client_id=test-client-id&redirect_uri=http%3A%2F%2Flocalhost%3A12345%2Foauth2callback&grant_type=authorization_code&client_secret=test-client-secret'
    );
  });
});

describe('exchangeCodeForTokens scope reporting', () => {
  it('passes the granted scopes from the token response through', async () => {
    vi.spyOn(curl, 'runCapturedAsync').mockResolvedValue({
      returncode: 0,
      stdout: JSON.stringify({
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'openid https://www.googleapis.com/auth/userinfo.email',
      }),
      stderr: '',
    });

    const tokens = await exchangeCodeForTokens(
      'https://oauth2.googleapis.com/token',
      'code',
      'client-id',
      'client-secret',
      'http://localhost:12345/oauth2callback'
    );

    expect(tokens.scope).toBe('openid https://www.googleapis.com/auth/userinfo.email');
  });
});

describe('findScopesNotGranted', () => {
  const requested = ['scope-a', 'scope-b', 'scope-c'];

  it('reports the requested scopes the response does not list', () => {
    expect(findScopesNotGranted(requested, 'scope-a scope-c')).toEqual(['scope-b']);
  });

  it('reports nothing when every requested scope was granted', () => {
    expect(findScopesNotGranted(requested, 'scope-c scope-b scope-a extra-scope')).toEqual([]);
  });

  it('treats an absent scope field as everything granted', () => {
    expect(findScopesNotGranted(requested, undefined)).toEqual([]);
  });

  it('treats an empty scope field as nothing granted', () => {
    expect(findScopesNotGranted(requested, '')).toEqual(requested);
  });

  it('tolerates irregular whitespace between scopes', () => {
    expect(findScopesNotGranted(requested, '  scope-a \n scope-b\tscope-c ')).toEqual([]);
  });
});

describe('refreshAccessToken', () => {
  it('confidential client: includes client_secret in body', async () => {
    const spy = vi.spyOn(curl, 'runCapturedAsync').mockImplementation(() => {
      throw new Error('STOP');
    });

    await expect(
      refreshAccessToken(
        'https://api.notion.com/v1/oauth/token',
        'refresh-token-xyz789',
        'test-client-id',
        'test-client-secret'
      )
    ).rejects.toThrow('STOP');

    const args = spy.mock.calls[0]![0];
    const body = args[args.indexOf('-d') + 1]!;
    expect(body).toBe(
      'refresh_token=refresh-token-xyz789&client_id=test-client-id&grant_type=refresh_token&client_secret=test-client-secret'
    );
  });

  it('public client: omits client_secret from body', async () => {
    const spy = vi.spyOn(curl, 'runCapturedAsync').mockImplementation(() => {
      throw new Error('STOP');
    });

    await expect(
      refreshAccessToken(
        'https://api.notion.com/v1/oauth/token',
        'refresh-token-xyz789',
        'test-client-id',
        ''
      )
    ).rejects.toThrow('STOP');

    const args = spy.mock.calls[0]![0];
    const body = args[args.indexOf('-d') + 1]!;
    expect(body).toBe(
      'refresh_token=refresh-token-xyz789&client_id=test-client-id&grant_type=refresh_token'
    );
  });
});
