/**
 * Tests for the generic cookie-capturing browser login used by registered
 * services.
 *
 * The capture is driven directly with `Set-Cookie` header values: no browser,
 * and no stubbed Playwright response, since reading those headers off a
 * response is all the session does.
 */

import { describe, it, expect } from 'vitest';
import type { ApiCredentials } from '../src/apiCredentials/base.js';
import { CookieCaptureLoginFlow } from '../src/services/core/cookieCapture.js';
import {
  formatLoginFlowsHelp,
  getLoginFlow,
  LOGIN_FLOWS,
  LoginFlowParamsInvalidError,
  resolveLoginFlow,
  UnknownLoginFlowError,
} from '../src/services/core/loginFlows.js';
import {
  buildRegisteredServiceOptions,
  RegisteredService,
} from '../src/services/core/registered.js';
import { ServiceSession, TELEGRAM } from '../src/services/index.js';

const LOGIN_URL = 'https://example.com/login';

/** The capture a service registered with these parameters would perform. */
function createCapture(
  cookieKeys: readonly string[],
  cookieUrl?: string
): { accept: (headers: readonly string[], responseUrl: string) => Promise<string | null> } {
  const flow = new CookieCaptureLoginFlow({ cookieKeys: [...cookieKeys], cookieUrl });
  const capture = flow.createCapture(LOGIN_URL);
  return {
    // Reduced to the Cookie header it would store, or null while incomplete.
    accept: async (headers, responseUrl) =>
      headerFrom(capture.accept(headers, new URL(responseUrl))),
  };
}

async function headerFrom(credentials: ApiCredentials | null): Promise<string | null> {
  if (credentials === null) {
    return null;
  }
  const curlArguments = await credentials.injectIntoCurlCall([]);
  return curlArguments[1] ?? null;
}

describe('cookie capture', () => {
  it('is not complete before the cookie is set', async () => {
    const capture = createCapture(['sessionid']);
    expect(await capture.accept([], LOGIN_URL)).toBeNull();
  });

  it('captures a cookie from a Set-Cookie header', async () => {
    const capture = createCapture(['sessionid']);
    expect(await capture.accept(['sessionid=abc123; Path=/; HttpOnly'], LOGIN_URL)).toBe(
      'Cookie: sessionid=abc123'
    );
  });

  it('ignores unrelated names, empty values and other domains', async () => {
    const capture = createCapture(['sessionid']);
    expect(
      await capture.accept(
        ['sessionid=wrong-domain; Path=/'],
        'https://identity-provider.example.net/sso'
      )
    ).toBeNull();
    expect(
      await capture.accept(['other=irrelevant; Path=/', 'sessionid=; Path=/'], LOGIN_URL)
    ).toBeNull();
  });

  it('waits for every requested cookie, across responses', async () => {
    const capture = createCapture(['sessionid', 'csrftoken']);
    expect(await capture.accept(['sessionid=abc; Path=/'], LOGIN_URL)).toBeNull();
    expect(await capture.accept(['csrftoken=xyz; Path=/'], LOGIN_URL)).toBe(
      'Cookie: sessionid=abc; csrftoken=xyz'
    );
  });

  it('keeps every scope when one name is set for several domains', async () => {
    const capture = createCapture(['sessionid'], 'https://app.example.com/');
    // A browser would send both, so both are kept rather than one being guessed.
    expect(
      await capture.accept(
        ['sessionid=host-only; Path=/', 'sessionid=domain-wide; Domain=example.com; Path=/'],
        'https://app.example.com/login'
      )
    ).toBe('Cookie: sessionid=host-only; sessionid=domain-wide');
  });

  it('replaces a cookie that is set again in the same scope', async () => {
    const capture = createCapture(['sessionid']);
    await capture.accept(['sessionid=first; Path=/'], LOGIN_URL);
    expect(await capture.accept(['sessionid=second; Path=/'], LOGIN_URL)).toBe(
      'Cookie: sessionid=second'
    );
  });

  it('drops a cookie that is cleared again', async () => {
    const capture = createCapture(['sessionid']);
    await capture.accept(['sessionid=abc; Path=/'], LOGIN_URL);
    expect(await capture.accept(['sessionid=abc; Max-Age=0; Path=/'], LOGIN_URL)).toBeNull();
  });

  it('looks for the cookies at the login URL when the parameters name no other', async () => {
    const capture = createCapture(['sessionid']);
    expect(await capture.accept(['sessionid=abc; Path=/'], LOGIN_URL)).toBe(
      'Cookie: sessionid=abc'
    );
  });

  it('matches against an explicit cookie URL when given', async () => {
    const capture = createCapture(['sessionid'], 'https://api.example.com/');
    // Set on the SSO host: applies to the API host only via the Domain attribute.
    expect(
      await capture.accept(['sessionid=sso-only; Path=/'], 'https://sso.example.com/login')
    ).toBeNull();
    expect(
      await capture.accept(
        ['sessionid=shared; Domain=example.com; Path=/'],
        'https://sso.example.com/login'
      )
    ).toBe('Cookie: sessionid=shared');
  });
});

describe('the login flow registry', () => {
  it('takes the registry entry from the class itself', () => {
    const flow = getLoginFlow(CookieCaptureLoginFlow.flowName);
    expect(flow?.name).toBe('cookie-capture');
    expect(flow?.summary).toBe(CookieCaptureLoginFlow.summary);
  });

  it('builds the register help text from the registered flows', () => {
    const help = formatLoginFlowsHelp();
    // Generated, not hand-written: a flow added later documents itself.
    for (const flow of LOGIN_FLOWS) {
      expect(help).toContain(flow.name);
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
