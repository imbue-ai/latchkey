/**
 * Tests for the generic cookie-capturing browser login used by registered
 * services.
 *
 * Everything goes through the public path a real login takes — a flow, the
 * service it is registered on, and the session that service hands out — with
 * responses fed in by hand instead of by a browser.
 */

import { describe, it, expect } from 'vitest';
import type { Response } from 'playwright';
import type { ApiCredentials } from '../src/apiCredentials/base.js';
import { CookieCaptureLoginFlow } from '../src/services/core/cookieCapture.js';
import {
  formatLoginFlowsHelp,
  getLoginFlow,
  LOGIN_FLOWS,
  resolveLoginFlow,
  UnknownLoginFlowError,
} from '../src/services/core/loginFlows.js';
import { LoginFlowParamsInvalidError } from '../src/services/core/base.js';
import {
  buildRegisteredServiceOptions,
  RegisteredService,
} from '../src/services/core/registered.js';
import { ServiceSession, SimpleServiceSession, TELEGRAM } from '../src/services/index.js';

const LOGIN_URL = 'https://example.com/login';

/** A response carrying nothing but the `Set-Cookie` headers under test. */
function responseWith(setCookieHeaders: readonly string[], url: string): Response {
  return {
    url: () => url,
    headersArray: () =>
      Promise.resolve([
        { name: 'Content-Type', value: 'text/html' },
        ...setCookieHeaders.map((value) => ({ name: 'set-cookie', value })),
      ]),
  } as unknown as Response;
}

async function headerFrom(credentials: ApiCredentials | null): Promise<string | null> {
  if (credentials === null) {
    return null;
  }
  const curlArguments = await credentials.injectIntoCurlCall([]);
  return curlArguments[1] ?? null;
}

/**
 * A login in progress for a service registered with these parameters: responses
 * go in, and out comes the `Cookie` header stored so far, or null.
 */
function startLogin(
  cookieKeys: readonly string[],
  cookieUrl?: string
): (setCookieHeaders: readonly string[], responseUrl?: string) => Promise<string | null> {
  const service = new RegisteredService('my-service', 'https://example.com/api/', {
    loginUrl: LOGIN_URL,
    loginFlow: new CookieCaptureLoginFlow({ cookieKeys: [...cookieKeys], cookieUrl }),
  });
  const session = service.getSession!('latchkey');
  if (!(session instanceof SimpleServiceSession)) {
    throw new TypeError('the cookie-capture flow should hand out a SimpleServiceSession');
  }
  return async (setCookieHeaders, responseUrl = LOGIN_URL) => {
    await session.onResponse(responseWith(setCookieHeaders, responseUrl));
    return headerFrom(session.capturedCredentials);
  };
}

describe('cookie capture', () => {
  it('is not complete before the cookie is set', async () => {
    const respond = startLogin(['sessionid']);
    expect(await respond([])).toBeNull();
  });

  it('captures a cookie from a Set-Cookie header', async () => {
    const respond = startLogin(['sessionid']);
    expect(await respond(['sessionid=abc123; Path=/; HttpOnly'])).toBe('Cookie: sessionid=abc123');
  });

  it('ignores unrelated names, empty values and other domains', async () => {
    const respond = startLogin(['sessionid']);
    expect(
      await respond(['sessionid=wrong-domain; Path=/'], 'https://identity-provider.example.net/sso')
    ).toBeNull();
    expect(await respond(['other=irrelevant; Path=/', 'sessionid=; Path=/'])).toBeNull();
  });

  it('waits for every requested cookie, across responses', async () => {
    const respond = startLogin(['sessionid', 'csrftoken']);
    expect(await respond(['sessionid=abc; Path=/'])).toBeNull();
    expect(await respond(['csrftoken=xyz; Path=/'])).toBe('Cookie: sessionid=abc; csrftoken=xyz');
  });

  it('keeps every scope when one name is set for several domains', async () => {
    const respond = startLogin(['sessionid'], 'https://app.example.com/');
    // A browser would send both, so both are kept rather than one being guessed.
    expect(
      await respond(
        ['sessionid=host-only; Path=/', 'sessionid=domain-wide; Domain=example.com; Path=/'],
        'https://app.example.com/login'
      )
    ).toBe('Cookie: sessionid=host-only; sessionid=domain-wide');
  });

  it('looks for the cookies at the login URL when the parameters name no other', async () => {
    const respond = startLogin(['sessionid']);
    expect(await respond(['sessionid=abc; Path=/'])).toBe('Cookie: sessionid=abc');
  });

  it('matches against an explicit cookie URL when given', async () => {
    const respond = startLogin(['sessionid'], 'https://api.example.com/');
    // Set on the SSO host: applies to the API host only via the Domain attribute.
    expect(
      await respond(['sessionid=sso-only; Path=/'], 'https://sso.example.com/login')
    ).toBeNull();
    expect(
      await respond(
        ['sessionid=shared; Domain=example.com; Path=/'],
        'https://sso.example.com/login'
      )
    ).toBe('Cookie: sessionid=shared');
  });

  it('stops capturing once the login is complete', async () => {
    const respond = startLogin(['sessionid']);
    expect(await respond(['sessionid=first; Path=/'])).toBe('Cookie: sessionid=first');
    // The session is done; a later response cannot change what was captured.
    expect(await respond(['sessionid=second; Path=/'])).toBe('Cookie: sessionid=first');
  });
});

describe('the login flow registry', () => {
  it('takes the registry entry from the class itself', () => {
    const flowClass = getLoginFlow(CookieCaptureLoginFlow.flowName);
    expect(flowClass).toBe(CookieCaptureLoginFlow);
    expect(flowClass?.flowName).toBe('cookie-capture');
  });

  it('builds the register help text from the registered flows', () => {
    const help = formatLoginFlowsHelp();
    // Generated, not hand-written: a flow added later documents itself.
    for (const flow of LOGIN_FLOWS) {
      expect(help).toContain(flow.flowName);
      expect(help).toContain(flow.summary);
      for (const detailLine of flow.details.split('\n').filter((line) => line !== '')) {
        expect(help).toContain(detailLine);
      }
    }
    expect(help).toContain('--login-flow-params');
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
    expect(service.getSession!('latchkey')).toBeInstanceOf(ServiceSession);
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
