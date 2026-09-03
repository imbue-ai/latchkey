/**
 * Tests for the generic token-capturing browser login used by registered
 * services.
 *
 * Everything goes through the public path a real login takes — a flow, the
 * service it is registered on, and the session that service hands out — with
 * responses fed in by hand instead of by a browser.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Page, Response } from 'playwright';
import type { ApiCredentials } from '../src/apiCredentials/base.js';
import { TokenCaptureLoginFlow } from '../src/services/core/loginFlows/tokenCapture.js';
import { LOGIN_FLOWS, resolveLoginFlow } from '../src/services/core/loginFlows/registry.js';
import { LoginFlowParamsInvalidError } from '../src/services/core/loginFlows/base.js';
import { RegisteredService } from '../src/services/core/registered.js';
import { SimpleServiceSession } from '../src/services/index.js';

const LOGIN_URL = 'https://app.example.com/auth/login';
const TOKEN_URL = 'https://app.example.com/api/auth/session';

/** A response carrying the JSON body under test. */
function responseWith(body: string, url: string): Response {
  return {
    url: () => url,
    text: () => Promise.resolve(body),
    headersArray: () => Promise.resolve([{ name: 'Content-Type', value: 'application/json' }]),
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
 * go in, and out comes the header stored so far, or null.
 */
function registerSession(params: {
  tokenUrl?: string;
  tokenField?: string;
  header?: string;
}): SimpleServiceSession {
  const service = new RegisteredService('my-service', 'https://app.example.com/backend-api/', {
    loginUrl: LOGIN_URL,
    loginFlow: new TokenCaptureLoginFlow({
      tokenUrl: params.tokenUrl ?? TOKEN_URL,
      tokenField: params.tokenField ?? 'accessToken',
      ...(params.header === undefined ? {} : { header: params.header }),
    }),
  });
  const session = service.getSession!('latchkey');
  if (!(session instanceof SimpleServiceSession)) {
    throw new TypeError('the token-capture flow should hand out a SimpleServiceSession');
  }
  return session;
}

function startLogin(params: {
  tokenUrl?: string;
  tokenField?: string;
  header?: string;
}): (body: string, responseUrl?: string) => Promise<string | null> {
  const session = registerSession(params);
  return async (body, responseUrl = TOKEN_URL) => {
    await session.onResponse(responseWith(body, responseUrl));
    return headerFrom(session.capturedCredentials);
  };
}

describe('token capture', () => {
  it('captures a token from the named endpoint', async () => {
    const respond = startLogin({});
    expect(await respond('{"accessToken": "tok-123", "user": {"email": "a@example.com"}}')).toBe(
      'Authorization: Bearer tok-123'
    );
  });

  // The signal is the token, not the request: the same endpoint answers a
  // signed-out visitor, and treating that as a finished login would store
  // nothing and call it success.
  it('is not complete while the endpoint answers without a token', async () => {
    const respond = startLogin({});
    expect(await respond('{}')).toBeNull();
    expect(await respond('{"accessToken": null}')).toBeNull();
    expect(await respond('{"accessToken": ""}')).toBeNull();
    expect(await respond('{"accessToken": "tok-123"}')).toBe('Authorization: Bearer tok-123');
  });

  it('ignores responses from other endpoints', async () => {
    const respond = startLogin({});
    expect(
      await respond('{"accessToken": "not-this-one"}', 'https://app.example.com/api/profile')
    ).toBeNull();
    expect(
      await respond('{"accessToken": "nor-this"}', 'https://identity-provider.example.net/session')
    ).toBeNull();
  });

  // A mint endpoint is commonly called with a parameter the registrant cannot
  // predict — NextAuth appends one — so matching the URL verbatim would mean
  // the flow silently never fires.
  it('matches the endpoint regardless of query string', async () => {
    const respond = startLogin({});
    expect(await respond('{"accessToken": "tok"}', `${TOKEN_URL}?_rsc=1a2b3`)).toBe(
      'Authorization: Bearer tok'
    );
  });

  it('reads a nested field', async () => {
    const respond = startLogin({ tokenField: 'data.session.token' });
    expect(await respond('{"data": {"session": {"token": "deep"}}}')).toBe(
      'Authorization: Bearer deep'
    );
  });

  it('does not mistake a non-object on the path for a token', async () => {
    const respond = startLogin({ tokenField: 'data.token' });
    expect(await respond('{"data": null}')).toBeNull();
    expect(await respond('{"data": ["token"]}')).toBeNull();
    expect(await respond('{"data": {"token": 42}}')).toBeNull();
  });

  // Waiting rather than failing: the response that carries the token may still
  // be coming, and a login that aborted on the first unparseable body would be
  // at the mercy of anything else the page fetches from that path.
  it('keeps waiting through a body that is not JSON', async () => {
    const respond = startLogin({});
    expect(await respond('<!doctype html><title>Just a moment...</title>')).toBeNull();
    expect(await respond('{"accessToken": "tok"}')).toBe('Authorization: Bearer tok');
  });

  it('stores the token in a custom header when one is registered', async () => {
    const respond = startLogin({ header: 'X-Auth-Token: {token}' });
    expect(await respond('{"accessToken": "tok"}')).toBe('X-Auth-Token: tok');
  });
});

/**
 * A browser parked at `pageUrl`, answering each request for the endpoint with
 * the next canned reply: a body, null for a request the endpoint refused, or an
 * Error the request rejects with.
 *
 * The last reply repeats, so a test that only cares about the first request
 * need not say what a second would get.
 */
function pageAt(
  pageUrl: string,
  replies: readonly (string | null | Error)[]
): { readonly page: Page; requestCount: () => number } {
  let requestCount = 0;
  const page = {
    url: () => pageUrl,
    evaluate: () => {
      const reply = replies[Math.min(requestCount, replies.length - 1)] ?? null;
      requestCount += 1;
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    },
  } as unknown as Page;
  return { page, requestCount: () => requestCount };
}

async function headerAfterWaiting(
  session: ReturnType<typeof registerSession>,
  page: Page
): Promise<string | null> {
  await session.whileWaitingForLogin(page);
  return headerFrom(session.capturedCredentials);
}

/**
 * Asking, rather than waiting to overhear.
 *
 * A web app calls its own mint endpoint when it wants a token and not
 * otherwise, so a login that only listens can wait forever on a service that is
 * working perfectly — which is what chatgpt.com does.
 */
describe('token capture by request', () => {
  const START_TIME = new Date('2026-01-01T00:00:00Z').getTime();
  // Comfortably past the interval between requests, whatever it is set to.
  const WELL_PAST_THE_INTERVAL_MS = 10_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_TIME);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks the endpoint when the app never calls it', async () => {
    const session = registerSession({});
    const { page } = pageAt('https://app.example.com/', ['{"accessToken": "tok-123"}']);
    expect(await headerAfterWaiting(session, page)).toBe('Authorization: Bearer tok-123');
  });

  // Mid-login the browser is commonly on an identity provider, where there is
  // nothing to ask and a cross-origin read would be refused anyway.
  it('does not ask while the browser is on another origin', async () => {
    const session = registerSession({});
    const { page, requestCount } = pageAt('https://identity-provider.example.net/consent', [
      '{"accessToken": "tok-123"}',
    ]);
    expect(await headerAfterWaiting(session, page)).toBeNull();
    expect(requestCount()).toBe(0);
  });

  it('does not ask again before the interval has passed', async () => {
    const session = registerSession({});
    const { page, requestCount } = pageAt('https://app.example.com/', ['{}']);
    await session.whileWaitingForLogin(page);
    await session.whileWaitingForLogin(page);
    expect(requestCount()).toBe(1);
  });

  // A signed-out visitor gets the same endpoint answering `{}`, so asking early
  // and often has to stay harmless.
  it('keeps asking until the endpoint has a token', async () => {
    const session = registerSession({});
    const { page } = pageAt('https://app.example.com/', ['{}', '{"accessToken": "tok-123"}']);
    expect(await headerAfterWaiting(session, page)).toBeNull();
    vi.setSystemTime(START_TIME + WELL_PAST_THE_INTERVAL_MS);
    expect(await headerAfterWaiting(session, page)).toBe('Authorization: Bearer tok-123');
  });

  // The page navigates out from under a request all the time during a login.
  it('keeps waiting when a request fails', async () => {
    const session = registerSession({});
    const { page } = pageAt('https://app.example.com/', [
      new Error('Execution context was destroyed'),
      '{"accessToken": "tok-123"}',
    ]);
    expect(await headerAfterWaiting(session, page)).toBeNull();
    vi.setSystemTime(START_TIME + WELL_PAST_THE_INTERVAL_MS);
    expect(await headerAfterWaiting(session, page)).toBe('Authorization: Bearer tok-123');
  });

  it('captures nothing from a request the endpoint refused', async () => {
    const session = registerSession({});
    const { page } = pageAt('https://app.example.com/', [null]);
    expect(await headerAfterWaiting(session, page)).toBeNull();
  });

  // Both paths write the same field, and the login keeps the first token.
  it('leaves a token already captured from a response alone', async () => {
    const session = registerSession({});
    await session.onResponse(responseWith('{"accessToken": "from-response"}', TOKEN_URL));
    const { page } = pageAt('https://app.example.com/', ['{"accessToken": "from-request"}']);
    expect(await headerAfterWaiting(session, page)).toBe('Authorization: Bearer from-response');
  });
});

describe('token capture parameters', () => {
  it('is registered under its flow name', () => {
    expect(LOGIN_FLOWS.map((flow) => flow.flowName)).toContain('token-capture');
    expect(
      resolveLoginFlow('token-capture', { tokenUrl: TOKEN_URL, tokenField: 'accessToken' })
    ).toBeInstanceOf(TokenCaptureLoginFlow);
  });

  it('requires a URL and a field', () => {
    expect(() => new TokenCaptureLoginFlow({})).toThrow(LoginFlowParamsInvalidError);
    expect(() => new TokenCaptureLoginFlow({ tokenUrl: TOKEN_URL })).toThrow(
      LoginFlowParamsInvalidError
    );
    expect(() => new TokenCaptureLoginFlow({ tokenUrl: 'not-a-url', tokenField: 'a' })).toThrow(
      LoginFlowParamsInvalidError
    );
  });

  // Caught at registration rather than as a puzzling 401 after a
  // successful-looking login.
  it('rejects a header that could not carry the token', () => {
    const base = { tokenUrl: TOKEN_URL, tokenField: 'accessToken' };
    expect(() => new TokenCaptureLoginFlow({ ...base, header: 'Authorization: Bearer' })).toThrow(
      LoginFlowParamsInvalidError
    );
    expect(() => new TokenCaptureLoginFlow({ ...base, header: 'no colon {token}' })).toThrow(
      LoginFlowParamsInvalidError
    );
  });

  it('rejects unknown parameters', () => {
    expect(
      () =>
        new TokenCaptureLoginFlow({
          tokenUrl: TOKEN_URL,
          tokenField: 'accessToken',
          cookieKeys: ['sessionid'],
        })
    ).toThrow(LoginFlowParamsInvalidError);
  });

  it('describes itself for `services info`', () => {
    const flow = new TokenCaptureLoginFlow({ tokenUrl: TOKEN_URL, tokenField: 'accessToken' });
    const description = flow.describe(LOGIN_URL);
    expect(description).toContain(LOGIN_URL);
    expect(description).toContain(TOKEN_URL);
    expect(description).toContain('accessToken');
  });
});
