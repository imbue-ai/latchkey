/**
 * Tests for the generic cookie-capturing browser login used by registered
 * services.
 *
 * Everything goes through the public path a real login takes — a flow, the
 * service it is registered on, and the session that service hands out — with
 * responses fed in by hand instead of by a browser.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Page, Response } from 'playwright';
import { type ApiCredentials, ApiCredentialStatus } from '../src/apiCredentials/base.js';
import { CookieCaptureLoginFlow } from '../src/services/core/loginFlows/cookieCapture.js';
import {
  formatLoginFlowsHelp,
  LOGIN_FLOWS,
  resolveLoginFlow,
  UnknownLoginFlowError,
} from '../src/services/core/loginFlows/registry.js';
import { LoginFlowParamsInvalidError } from '../src/services/core/loginFlows/base.js';
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

/** A registered service whose credential check always gives this answer. */
class CheckedService extends RegisteredService {
  constructor(
    options: ConstructorParameters<typeof RegisteredService>[2],
    private readonly checkResult: ApiCredentialStatus
  ) {
    super('my-service', 'https://example.com/api/', options);
  }

  override checkApiCredentials(): Promise<ApiCredentialStatus> {
    return Promise.resolve(this.checkResult);
  }
}

/** A fresh login session for a service registered with these parameters. */
function registerSession(
  cookieKeys: readonly string[],
  cookieUrl?: string,
  checkResult: ApiCredentialStatus = ApiCredentialStatus.Unknown
): SimpleServiceSession {
  const service = new CheckedService(
    {
      loginUrl: LOGIN_URL,
      loginFlow: new CookieCaptureLoginFlow({ cookieKeys: [...cookieKeys], cookieUrl }),
    },
    checkResult
  );
  const session = service.getSession!('latchkey');
  if (!(session instanceof SimpleServiceSession)) {
    throw new TypeError('the cookie-capture flow should hand out a SimpleServiceSession');
  }
  return session;
}

/**
 * A login in progress for a service registered with these parameters: responses
 * go in, and out comes the `Cookie` header stored so far, or null.
 */
function startLogin(
  cookieKeys: readonly string[],
  cookieUrl?: string
): (setCookieHeaders: readonly string[], responseUrl?: string) => Promise<string | null> {
  const session = registerSession(cookieKeys, cookieUrl);
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

  it('defaults a cookie without Path to the directory that set it', async () => {
    const setAtLoginPage = ['sessionid=abc'];
    // The login page is /login, so a cookie without Path applies to / only
    // because that is its directory; one set deeper does not reach the root.
    expect(await startLogin(['sessionid'])(setAtLoginPage)).toBe('Cookie: sessionid=abc');
    expect(
      await startLogin(['sessionid'])(setAtLoginPage, 'https://example.com/account/settings')
    ).toBeNull();
  });

  it('applies a Domain cookie to subdomains, with or without the leading dot', async () => {
    for (const domainAttribute of ['Domain=example.com', 'Domain=.example.com']) {
      const respond = startLogin(['sessionid'], 'https://api.example.com/');
      expect(
        await respond([`sessionid=abc; ${domainAttribute}; Path=/`], 'https://sso.example.com/in')
      ).toBe('Cookie: sessionid=abc');
    }
  });

  it('ignores header values that are not a cookie assignment', async () => {
    const respond = startLogin(['sessionid']);
    expect(await respond(['not-a-cookie', '=orphan-value'])).toBeNull();
  });

  it('replaces a cookie set again before the login finishes', async () => {
    const respond = startLogin(['sessionid', 'csrftoken']);
    expect(await respond(['sessionid=first; Path=/'])).toBeNull();
    expect(await respond(['sessionid=second; Path=/'])).toBeNull();
    expect(await respond(['csrftoken=xyz; Path=/'])).toBe(
      'Cookie: sessionid=second; csrftoken=xyz'
    );
  });

  it('drops a cookie that is cleared again', async () => {
    for (const clearingHeader of [
      'sessionid=; Path=/',
      'sessionid=abc; Max-Age=0; Path=/',
      'sessionid=abc; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/',
    ]) {
      const respond = startLogin(['sessionid', 'csrftoken']);
      await respond(['sessionid=abc; Path=/']);
      await respond([clearingHeader]);
      expect(await respond(['csrftoken=xyz; Path=/'])).toBeNull();
    }
  });

  it('keeps a cookie whose expiry is still in the future', async () => {
    const expires = new Date(Date.now() + 60_000).toUTCString();
    const respond = startLogin(['sessionid']);
    expect(await respond([`sessionid=abc; Expires=${expires}; Path=/`])).toBe(
      'Cookie: sessionid=abc'
    );
  });

  it('stops capturing once the login is complete', async () => {
    const respond = startLogin(['sessionid']);
    expect(await respond(['sessionid=first; Path=/'])).toBe('Cookie: sessionid=first');
    // The session is done; a later response cannot change what was captured.
    expect(await respond(['sessionid=second; Path=/'])).toBe('Cookie: sessionid=first');
  });
});

/** A cookie as the browser holds it, reduced to what decides where it applies. */
interface BrowserCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
}

/**
 * A browser parked at `pageUrl` and holding `cookies`. Its cookie store hands
 * out only the cookies whose domain covers the URL asked about, as a real one
 * does.
 */
function browserAt(pageUrl: string, cookies: readonly BrowserCookie[]): Page {
  return {
    url: () => pageUrl,
    context: () => ({
      cookies: (url: string) => {
        const host = new URL(url).hostname;
        return Promise.resolve(
          cookies.filter((cookie) => host === cookie.domain || host.endsWith(`.${cookie.domain}`))
        );
      },
    }),
  } as unknown as Page;
}

async function headerAfterWaiting(
  session: SimpleServiceSession,
  page: Page
): Promise<string | null> {
  await session.whileWaitingForLogin(page);
  return headerFrom(session.capturedCredentials);
}

/**
 * A browser that opens already signed in — from saved browser state, or after
 * `auth import-chrome` — is never sent its session cookie again, so a login
 * that only watches `Set-Cookie` would wait forever.
 */
describe('cookie capture from a browser already signed in', () => {
  const START_TIME = new Date('2026-01-01T00:00:00Z').getTime();
  // Comfortably past the interval between looks, whatever it is set to.
  const WELL_PAST_THE_INTERVAL_MS = 10_000;
  const SESSION_COOKIE = { name: 'sessionid', value: 'existing', domain: 'example.com' };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_TIME);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('takes the cookie once the page has moved on from the login page', async () => {
    const session = registerSession(['sessionid']);
    const page = browserAt('https://example.com/home', [SESSION_COOKIE]);
    expect(await headerAfterWaiting(session, page)).toBe('Cookie: sessionid=existing');
  });

  // A stale session stays on the login page, where the user signs in afresh.
  it('waits while the page is still on the login page', async () => {
    const session = registerSession(['sessionid']);
    expect(
      await headerAfterWaiting(session, browserAt(`${LOGIN_URL}?next=/home`, [SESSION_COOKIE]))
    ).toBeNull();
    await session.onResponse(responseWith(['sessionid=fresh; Path=/'], LOGIN_URL));
    expect(await headerFrom(session.capturedCredentials)).toBe('Cookie: sessionid=fresh');
  });

  it('takes the cookie after the page leaves the login page', async () => {
    const session = registerSession(['sessionid']);
    expect(await headerAfterWaiting(session, browserAt(LOGIN_URL, [SESSION_COOKIE]))).toBeNull();
    vi.setSystemTime(START_TIME + WELL_PAST_THE_INTERVAL_MS);
    expect(
      await headerAfterWaiting(session, browserAt('https://example.com/home', [SESSION_COOKIE]))
    ).toBe('Cookie: sessionid=existing');
  });

  // Mid-login the browser is commonly on an identity provider.
  it('waits while the page is on another site', async () => {
    const session = registerSession(['sessionid']);
    const page = browserAt('https://identity-provider.example.net/consent', [SESSION_COOKIE]);
    expect(await headerAfterWaiting(session, page)).toBeNull();
  });

  it('waits while the page is not on a URL at all', async () => {
    const session = registerSession(['sessionid']);
    expect(
      await headerAfterWaiting(session, browserAt('about:blank', [SESSION_COOKIE]))
    ).toBeNull();
  });

  it('waits when the browser has no such cookie', async () => {
    const session = registerSession(['sessionid']);
    const page = browserAt('https://example.com/home', [
      { name: 'other', value: 'irrelevant', domain: 'example.com' },
      { name: 'sessionid', value: '', domain: 'example.com' },
    ]);
    expect(await headerAfterWaiting(session, page)).toBeNull();
  });

  it('waits for every requested cookie', async () => {
    const session = registerSession(['sessionid', 'csrftoken']);
    expect(
      await headerAfterWaiting(session, browserAt('https://example.com/home', [SESSION_COOKIE]))
    ).toBeNull();
    vi.setSystemTime(START_TIME + WELL_PAST_THE_INTERVAL_MS);
    expect(
      await headerAfterWaiting(
        session,
        browserAt('https://example.com/home', [
          SESSION_COOKIE,
          { name: 'csrftoken', value: 'xyz', domain: 'example.com' },
        ])
      )
    ).toBe('Cookie: sessionid=existing; csrftoken=xyz');
  });

  it('only takes cookies that apply to the cookie URL', async () => {
    const session = registerSession(['sessionid'], 'https://api.example.com/');
    const page = browserAt('https://api.example.com/home', [
      { name: 'sessionid', value: 'elsewhere', domain: 'sso.example.com' },
    ]);
    expect(await headerAfterWaiting(session, page)).toBeNull();
    vi.setSystemTime(START_TIME + WELL_PAST_THE_INTERVAL_MS);
    expect(
      await headerAfterWaiting(
        session,
        browserAt('https://api.example.com/home', [
          { name: 'sessionid', value: 'shared', domain: 'example.com' },
        ])
      )
    ).toBe('Cookie: sessionid=shared');
  });

  it('does not look again before the interval has passed', async () => {
    const session = registerSession(['sessionid']);
    expect(await headerAfterWaiting(session, browserAt('https://example.com/home', []))).toBeNull();
    expect(
      await headerAfterWaiting(session, browserAt('https://example.com/home', [SESSION_COOKIE]))
    ).toBeNull();
  });

  it('turns down a cookie the service says is invalid', async () => {
    const session = registerSession(['sessionid'], undefined, ApiCredentialStatus.Invalid);
    const page = browserAt('https://example.com/home', [SESSION_COOKIE]);
    expect(await headerAfterWaiting(session, page)).toBeNull();
  });

  it('takes a cookie the service says is valid', async () => {
    const session = registerSession(['sessionid'], undefined, ApiCredentialStatus.Valid);
    const page = browserAt('https://example.com/home', [SESSION_COOKIE]);
    expect(await headerAfterWaiting(session, page)).toBe('Cookie: sessionid=existing');
  });

  it('leaves a cookie already captured from a response alone', async () => {
    const session = registerSession(['sessionid']);
    await session.onResponse(responseWith(['sessionid=from-response; Path=/'], LOGIN_URL));
    const page = browserAt('https://example.com/home', [SESSION_COOKIE]);
    expect(await headerAfterWaiting(session, page)).toBe('Cookie: sessionid=from-response');
  });
});

describe('the login flow registry', () => {
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
