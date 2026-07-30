/**
 * Tests for the generic cookie-capturing browser login used by registered
 * services. No browser is launched: the login phase is driven with stub
 * responses carrying `Set-Cookie` headers.
 */

import { describe, it, expect } from 'vitest';
import type { Response } from 'playwright';
import type { ApiCredentials } from '../src/apiCredentials/base.js';
import { CookieCaptureServiceSession } from '../src/services/core/cookieCapture.js';
import {
  getLoginFlow,
  LoginFlowParamsInvalidError,
  resolveLoginFlow,
  UnknownLoginFlowError,
} from '../src/services/core/loginFlows.js';
import {
  buildRegisteredServiceOptions,
  RegisteredService,
} from '../src/services/core/registered.js';
import { TELEGRAM } from '../src/services/index.js';

const LOGIN_URL = 'https://example.com/login';

function createStubResponse(url: string, setCookieHeaders: readonly string[]): Response {
  return {
    url: () => url,
    headersArray: () =>
      Promise.resolve([
        { name: 'Content-Type', value: 'text/html' },
        ...setCookieHeaders.map((value) => ({ name: 'set-cookie', value })),
      ]),
  } as unknown as Response;
}

/** The login-phase hook, which is protected on the session. */
interface SessionLoginPhase {
  getApiCredentialsFromResponse(response: Response): Promise<ApiCredentials | null>;
}

function createSession(
  cookieKeys: readonly string[],
  cookieUrl: string = LOGIN_URL
): CookieCaptureServiceSession & SessionLoginPhase {
  return new CookieCaptureServiceSession(
    new RegisteredService('my-service', 'https://example.com/api/'),
    'latchkey',
    { cookieKeys: [...cookieKeys], cookieUrl }
  ) as CookieCaptureServiceSession & SessionLoginPhase;
}

async function headerFrom(credentials: ApiCredentials | null): Promise<string | null> {
  if (credentials === null) {
    return null;
  }
  const curlArguments = await credentials.injectIntoCurlCall([]);
  return curlArguments[1] ?? null;
}

describe('CookieCaptureServiceSession', () => {
  it('is not complete before the cookie is set', async () => {
    const session = createSession(['sessionid']);
    const credentials = await session.getApiCredentialsFromResponse(
      createStubResponse(LOGIN_URL, [])
    );
    expect(credentials).toBeNull();
  });

  it('captures a cookie from a Set-Cookie header', async () => {
    const session = createSession(['sessionid']);
    const credentials = await session.getApiCredentialsFromResponse(
      createStubResponse(LOGIN_URL, ['sessionid=abc123; Path=/; HttpOnly'])
    );
    expect(await headerFrom(credentials)).toBe('Cookie: sessionid=abc123');
  });

  it('ignores unrelated names, empty values and other domains', async () => {
    const session = createSession(['sessionid']);
    expect(
      await session.getApiCredentialsFromResponse(
        createStubResponse('https://identity-provider.example.net/sso', [
          'sessionid=wrong-domain; Path=/',
        ])
      )
    ).toBeNull();
    expect(
      await session.getApiCredentialsFromResponse(
        createStubResponse(LOGIN_URL, ['other=irrelevant; Path=/', 'sessionid=; Path=/'])
      )
    ).toBeNull();
  });

  it('waits for every requested cookie, across responses', async () => {
    const session = createSession(['sessionid', 'csrftoken']);

    expect(
      await session.getApiCredentialsFromResponse(
        createStubResponse(LOGIN_URL, ['sessionid=abc; Path=/'])
      )
    ).toBeNull();

    const credentials = await session.getApiCredentialsFromResponse(
      createStubResponse(LOGIN_URL, ['csrftoken=xyz; Path=/'])
    );
    expect(await headerFrom(credentials)).toBe('Cookie: sessionid=abc; csrftoken=xyz');
  });

  it('keeps every scope when one name is set for several domains', async () => {
    const session = createSession(['sessionid'], 'https://app.example.com/');
    const credentials = await session.getApiCredentialsFromResponse(
      createStubResponse('https://app.example.com/login', [
        'sessionid=host-only; Path=/',
        'sessionid=domain-wide; Domain=example.com; Path=/',
      ])
    );
    // A browser would send both, so both are kept rather than one being guessed.
    expect(await headerFrom(credentials)).toBe(
      'Cookie: sessionid=host-only; sessionid=domain-wide'
    );
  });

  it('replaces a cookie that is set again in the same scope', async () => {
    const session = createSession(['sessionid']);
    await session.getApiCredentialsFromResponse(
      createStubResponse(LOGIN_URL, ['sessionid=first; Path=/'])
    );
    const credentials = await session.getApiCredentialsFromResponse(
      createStubResponse(LOGIN_URL, ['sessionid=second; Path=/'])
    );
    expect(await headerFrom(credentials)).toBe('Cookie: sessionid=second');
  });

  it('drops a cookie that is cleared again', async () => {
    const session = createSession(['sessionid']);
    await session.getApiCredentialsFromResponse(
      createStubResponse(LOGIN_URL, ['sessionid=abc; Path=/'])
    );
    const credentials = await session.getApiCredentialsFromResponse(
      createStubResponse(LOGIN_URL, ['sessionid=abc; Max-Age=0; Path=/'])
    );
    expect(credentials).toBeNull();
  });

  it('matches against an explicit cookie URL when given', async () => {
    const session = createSession(['sessionid'], 'https://api.example.com/');
    // Set on the SSO host: applies to the API host only via the Domain attribute.
    expect(
      await session.getApiCredentialsFromResponse(
        createStubResponse('https://sso.example.com/login', ['sessionid=sso-only; Path=/'])
      )
    ).toBeNull();
    const credentials = await session.getApiCredentialsFromResponse(
      createStubResponse('https://sso.example.com/login', [
        'sessionid=shared; Domain=example.com; Path=/',
      ])
    );
    expect(await headerFrom(credentials)).toBe('Cookie: sessionid=shared');
  });
});

describe('the login flow registry', () => {
  it('takes the registry entry from the class itself', () => {
    const flow = getLoginFlow(CookieCaptureServiceSession.flowName);
    expect(flow?.name).toBe('cookie-capture');
    expect(flow?.summary).toBe(CookieCaptureServiceSession.summary);
  });

  it('rejects an unknown flow', () => {
    expect(() => resolveLoginFlow('nonexistent', {})).toThrow(UnknownLoginFlowError);
  });

  it('rejects parameters that do not match the flow schema', () => {
    const invalidParameterSets = [
      {},
      { cookieKeys: [] },
      { cookieKeys: 'sessionid' },
      { cookieKeys: ['sessionid'], cookieUrl: 'example.com' },
      { cookieKeys: ['sessionid'], typo: true },
    ];
    for (const params of invalidParameterSets) {
      expect(() => resolveLoginFlow('cookie-capture', params)).toThrow(LoginFlowParamsInvalidError);
    }
  });

  it('accepts valid cookie-capture parameters', () => {
    const flow = resolveLoginFlow('cookie-capture', {
      cookieKeys: ['sessionid'],
      cookieUrl: 'https://api.example.com/',
    });
    expect(flow.describe(LOGIN_URL)).toContain(LOGIN_URL);
    expect(flow.describe(LOGIN_URL)).toContain('sessionid');
  });
});

describe('RegisteredService with a login flow', () => {
  const cookieFlow = () => resolveLoginFlow('cookie-capture', { cookieKeys: ['sessionid'] });

  it('exposes the flow as its browser login', () => {
    const service = new RegisteredService('my-service', 'https://example.com/api/', {
      loginUrl: LOGIN_URL,
      loginFlow: cookieFlow(),
    });
    expect(service.getSession).toBeDefined(); // eslint-disable-line @typescript-eslint/unbound-method
    expect(service.getSession!('latchkey')).toBeInstanceOf(CookieCaptureServiceSession);
    expect(service.info).toContain(LOGIN_URL);
    expect(service.info).toContain('sessionid');
  });

  // The two combinations that used to be checked at runtime — a flow without a
  // page to open, and a flow alongside a family service — are now rejected by
  // the options type. These assertions fail the build if that stops being true,
  // since an unused @ts-expect-error is itself an error.
  it('rejects a login flow without a login URL at compile time', () => {
    // @ts-expect-error -- a login flow requires a loginUrl to start from
    const service = new RegisteredService('my-service', 'https://example.com/api/', {
      loginFlow: cookieFlow(),
    });
    expect(service.getSession).toBeUndefined(); // eslint-disable-line @typescript-eslint/unbound-method
  });

  it('rejects a login flow combined with a family service at compile time', () => {
    const service = new RegisteredService('my-service', 'https://example.com/api/', {
      familyService: TELEGRAM,
      loginUrl: LOGIN_URL,
      // @ts-expect-error -- a family service brings its own login
      loginFlow: cookieFlow(),
    });
    expect(service.getSession).toBeUndefined(); // eslint-disable-line @typescript-eslint/unbound-method
  });

  it('rejects a bare service in place of the options at compile time', () => {
    // @ts-expect-error -- Service overlaps structurally, but is not options
    const service = new RegisteredService('my-service', 'https://example.com/api/', TELEGRAM);
    expect(service.getSession).toBeUndefined(); // eslint-disable-line @typescript-eslint/unbound-method
  });
});

describe('buildRegisteredServiceOptions', () => {
  const cookieFlow = () => resolveLoginFlow('cookie-capture', { cookieKeys: ['sessionid'] });

  it('prefers the family service when both are somehow present', () => {
    const options = buildRegisteredServiceOptions(TELEGRAM, LOGIN_URL, cookieFlow());
    expect(options?.familyService).toBe(TELEGRAM);
    expect(options?.loginFlow).toBeUndefined();
  });

  it('drops a login flow that has no login URL', () => {
    expect(buildRegisteredServiceOptions(undefined, undefined, cookieFlow())).toBeUndefined();
  });

  it('returns no options when there is no login at all', () => {
    expect(buildRegisteredServiceOptions(undefined, undefined, undefined)).toBeUndefined();
  });
});
