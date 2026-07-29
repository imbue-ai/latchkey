/**
 * Tests for the generic cookie-capturing browser login used by registered
 * services. No browser is launched: the login-phase polling is driven with a
 * stub page whose context reports a scripted set of cookies.
 */

import { describe, it, expect } from 'vitest';
import type { Page } from 'playwright';
import type { ApiCredentials } from '../src/apiCredentials/base.js';
import { CookieCaptureServiceSession } from '../src/services/core/cookieCapture.js';
import { RegisteredService } from '../src/services/core/registered.js';
import { TELEGRAM } from '../src/services/index.js';

const LOGIN_URL = 'https://example.com/login';

interface StubCookie {
  readonly name: string;
  readonly value: string;
}

/**
 * A stand-in for a Playwright page whose context returns the cookies scoped to
 * the requested URL. `cookiesByUrl` mirrors what the real API does: cookies are
 * only visible for URLs their domain matches.
 */
function createStubPage(cookiesByUrl: Readonly<Record<string, readonly StubCookie[]>>): Page {
  const context = {
    cookies: (urls?: string) =>
      Promise.resolve(urls === undefined ? [] : (cookiesByUrl[urls] ?? [])),
  };
  return { context: () => context } as unknown as Page;
}

/** The login-phase hooks, which are protected on the session. */
interface SessionLoginPhase {
  checkLoginProgress(page: Page): Promise<void>;
  isLoginComplete(): boolean;
  finalizeCredentials(): Promise<ApiCredentials | null>;
}

function createSession(
  cookieKeys: readonly string[],
  cookieUrl: string = LOGIN_URL
): CookieCaptureServiceSession & SessionLoginPhase {
  const service = new RegisteredService('my-service', 'https://example.com/api/', {
    loginUrl: LOGIN_URL,
    cookieKeys,
    cookieUrl,
  });
  return new CookieCaptureServiceSession(
    service,
    'latchkey',
    cookieKeys,
    cookieUrl
  ) as CookieCaptureServiceSession & SessionLoginPhase;
}

describe('CookieCaptureServiceSession', () => {
  it('is not complete before the cookie appears', async () => {
    const session = createSession(['session_id']);
    await session.checkLoginProgress(createStubPage({ [LOGIN_URL]: [] }));
    expect(session.isLoginComplete()).toBe(false);
    expect(await session.finalizeCredentials()).toBeNull();
  });

  it('captures the cookie and stores it as a Cookie header', async () => {
    const session = createSession(['session_id']);
    await session.checkLoginProgress(
      createStubPage({ [LOGIN_URL]: [{ name: 'session_id', value: 'abc123' }] })
    );

    expect(session.isLoginComplete()).toBe(true);
    const credentials = await session.finalizeCredentials();
    expect(credentials).not.toBeNull();
    expect(await credentials!.injectIntoCurlCall(['https://example.com/api/me'])).toEqual([
      '-H',
      'Cookie: session_id=abc123',
      'https://example.com/api/me',
    ]);
  });

  it('ignores other cookies and empty values', async () => {
    const session = createSession(['session_id']);
    await session.checkLoginProgress(
      createStubPage({
        [LOGIN_URL]: [
          { name: 'other', value: 'irrelevant' },
          { name: 'session_id', value: '' },
        ],
      })
    );
    expect(session.isLoginComplete()).toBe(false);
  });

  it('ignores a same-named cookie belonging to another domain', async () => {
    const session = createSession(['session_id']);
    await session.checkLoginProgress(
      createStubPage({
        'https://identity-provider.example.net/': [{ name: 'session_id', value: 'wrong' }],
      })
    );
    expect(session.isLoginComplete()).toBe(false);
  });

  it('keeps every match when one name is set on several domains', async () => {
    const session = createSession(['session_id']);
    await session.checkLoginProgress(
      createStubPage({
        // The same name can exist both host-only and domain-wide; a browser
        // sends both, so both are captured rather than one being guessed at.
        [LOGIN_URL]: [
          { name: 'session_id', value: 'from-domain-cookie' },
          { name: 'session_id', value: 'from-host-only-cookie' },
        ],
      })
    );

    const credentials = await session.finalizeCredentials();
    expect(await credentials!.injectIntoCurlCall([])).toEqual([
      '-H',
      'Cookie: session_id=from-domain-cookie; session_id=from-host-only-cookie',
    ]);
  });

  it('waits for every requested cookie before completing', async () => {
    const session = createSession(['sessionid', 'csrftoken']);

    await session.checkLoginProgress(
      createStubPage({ [LOGIN_URL]: [{ name: 'sessionid', value: 'abc' }] })
    );
    expect(session.isLoginComplete()).toBe(false);

    await session.checkLoginProgress(
      createStubPage({
        [LOGIN_URL]: [
          { name: 'sessionid', value: 'abc' },
          { name: 'unrelated', value: 'ignored' },
          { name: 'csrftoken', value: 'xyz' },
        ],
      })
    );
    expect(session.isLoginComplete()).toBe(true);

    const credentials = await session.finalizeCredentials();
    expect(await credentials!.injectIntoCurlCall([])).toEqual([
      '-H',
      'Cookie: sessionid=abc; csrftoken=xyz',
    ]);
  });

  it('reads the cookie from an explicit cookie URL when given', async () => {
    const apiUrl = 'https://api.example.com/';
    const session = createSession(['session_id'], apiUrl);
    await session.checkLoginProgress(
      createStubPage({
        [LOGIN_URL]: [{ name: 'session_id', value: 'login-page-cookie' }],
        [apiUrl]: [{ name: 'session_id', value: 'api-cookie' }],
      })
    );

    const credentials = await session.finalizeCredentials();
    expect(await credentials!.injectIntoCurlCall([])).toEqual([
      '-H',
      'Cookie: session_id=api-cookie',
    ]);
  });
});

describe('RegisteredService with a cookie key', () => {
  it('exposes a cookie-capturing browser login', () => {
    const service = new RegisteredService('my-service', 'https://example.com/api/', {
      loginUrl: LOGIN_URL,
      cookieKeys: ['session_id'],
    });
    expect(service.getSession).toBeDefined(); // eslint-disable-line @typescript-eslint/unbound-method
    expect(service.getSession!('latchkey')).toBeInstanceOf(CookieCaptureServiceSession);
    expect(service.info).toContain(LOGIN_URL);
    expect(service.info).toContain('session_id');
  });

  it('does not expose a browser login without a login URL', () => {
    const service = new RegisteredService('my-service', 'https://example.com/api/', {
      cookieKeys: ['session_id'],
    });
    expect(service.getSession).toBeUndefined(); // eslint-disable-line @typescript-eslint/unbound-method
  });

  it('does not expose a browser login when a family service is also given', () => {
    const service = new RegisteredService('my-service', 'https://example.com/api/', {
      familyService: TELEGRAM,
      loginUrl: LOGIN_URL,
      cookieKeys: ['session_id'],
    });
    expect(service.getSession).toBeUndefined(); // eslint-disable-line @typescript-eslint/unbound-method
  });
});
