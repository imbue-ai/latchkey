import { describe, it, expect } from 'vitest';
import type { Response } from 'playwright';
import { GREENHOUSE } from '../src/services/greenhouse.js';
import { AuthorizationBare } from '../src/apiCredentials/base.js';
import { SERVICE_REGISTRY } from '../src/serviceRegistry.js';

// The live Dev Center browser flow can't be exercised without a real Greenhouse
// org, so these tests cover the parts that don't need a browser: credential
// construction parity, URL matching, the info string, and the login-detection
// heuristic in the session's onResponse handler.

// Build a minimal Playwright Response stand-in for onResponse.
function makeResponse(options: {
  url: string;
  status?: number;
  resourceType?: string;
  method?: string;
}): Response {
  const { url, status = 200, resourceType = 'document', method = 'GET' } = options;
  const request = {
    url: () => url,
    method: () => method,
    resourceType: () => resourceType,
    headers: () => ({}),
  };
  return {
    request: () => request,
    status: () => status,
  } as unknown as Response;
}

// Expose the protected login-completion check for assertions.
interface LoginProbe {
  onResponse(response: Response): void;
  isLoginComplete(): boolean;
}

function newSessionProbe(): LoginProbe {
  return GREENHOUSE.getSession('latchkey') as unknown as LoginProbe;
}

describe('Greenhouse URL matching', () => {
  it('matches the Harvest API host', () => {
    expect(SERVICE_REGISTRY.getByUrl('https://harvest.greenhouse.io/v1/users')).toBe(GREENHOUSE);
  });
});

describe('Greenhouse Harvest Basic auth credentials', () => {
  it('builds Basic auth with the key as username and a blank password', async () => {
    const credentials = GREENHOUSE.getCredentialsNoCurl(['my-secret-key']);
    expect(credentials).toBeInstanceOf(AuthorizationBare);

    const expectedToken = `Basic ${Buffer.from('my-secret-key:').toString('base64')}`;
    expect((credentials as AuthorizationBare).token).toBe(expectedToken);

    const args = await credentials.injectIntoCurlCall(['https://harvest.greenhouse.io/v1/users']);
    expect(args).toEqual([
      '-H',
      `Authorization: ${expectedToken}`,
      'https://harvest.greenhouse.io/v1/users',
    ]);
  });

  it('rejects missing, empty, or extra arguments', () => {
    expect(() => GREENHOUSE.getCredentialsNoCurl([])).toThrow();
    expect(() => GREENHOUSE.getCredentialsNoCurl([''])).toThrow();
    expect(() => GREENHOUSE.getCredentialsNoCurl(['a', 'b'])).toThrow();
  });
});

describe('Greenhouse info string', () => {
  it('mentions both the browser and manual flows', () => {
    expect(GREENHOUSE.info).toContain('latchkey auth browser greenhouse');
    expect(GREENHOUSE.info).toContain('latchkey auth set-nocurl greenhouse');
  });
});

describe('Greenhouse browser session', () => {
  it('exposes a session with an onResponse handler', () => {
    const session = GREENHOUSE.getSession('latchkey');
    expect(typeof session.onResponse).toBe('function');
  });

  it('treats a successful in-app navigation as logged in', () => {
    const probe = newSessionProbe();
    expect(probe.isLoginComplete()).toBe(false);
    probe.onResponse(makeResponse({ url: 'https://app.greenhouse.io/dashboard' }));
    expect(probe.isLoginComplete()).toBe(true);
  });

  it('does not treat authentication pages as logged in', () => {
    const probe = newSessionProbe();
    probe.onResponse(makeResponse({ url: 'https://app.greenhouse.io/users/sign_in' }));
    expect(probe.isLoginComplete()).toBe(false);
  });

  it('ignores non-document, non-2XX, and off-domain responses', () => {
    const xhr = newSessionProbe();
    xhr.onResponse(
      makeResponse({ url: 'https://app.greenhouse.io/dashboard', resourceType: 'xhr' })
    );
    expect(xhr.isLoginComplete()).toBe(false);

    const error = newSessionProbe();
    error.onResponse(makeResponse({ url: 'https://app.greenhouse.io/dashboard', status: 401 }));
    expect(error.isLoginComplete()).toBe(false);

    const offDomain = newSessionProbe();
    offDomain.onResponse(makeResponse({ url: 'https://example.com/dashboard' }));
    expect(offDomain.isLoginComplete()).toBe(false);
  });
});
