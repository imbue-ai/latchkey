/**
 * Tests for the Slack browser login, with responses and the browser's state fed
 * in by hand instead of by a browser.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Page, Response } from 'playwright';
import {
  SLACK,
  SlackApiCredentials,
  SlackSessionCookieMissingError,
  SlackTokenMissingError,
} from '../src/services/slack.js';
import { SimpleServiceSession } from '../src/services/core/base.js';

const CLIENT_URL = 'https://app.slack.com/client/T123/C456';
const SIGNIN_URL = 'https://slack.com/signin';
const CLIENT_BODY_WITH_TOKEN = '<html><script>{"api_token":"xoxc-123-abc","x":1}</script></html>';

const START_TIME = new Date('2026-01-01T00:00:00Z').getTime();
// Comfortably past the grace period, whatever it is set to.
const WELL_PAST_THE_GRACE_PERIOD_MS = 60_000;

function responseWith(params: {
  url?: string;
  body?: string;
  cookieHeader?: string;
}): Response {
  const headers: Record<string, string> =
    params.cookieHeader === undefined ? {} : { cookie: params.cookieHeader };
  return {
    request: () => ({
      url: () => params.url ?? CLIENT_URL,
      allHeaders: () => Promise.resolve(headers),
    }),
    text: () => Promise.resolve(params.body ?? CLIENT_BODY_WITH_TOKEN),
  } as unknown as Response;
}

/** A browser parked at `pageUrl` whose jar holds the given cookies. */
function pageAt(
  pageUrl: string,
  cookies: readonly { name: string; value: string; domain: string }[] = []
): Page {
  return {
    url: () => pageUrl,
    context: () => ({ cookies: () => Promise.resolve(cookies) }),
  } as unknown as Page;
}

function startLogin(): SimpleServiceSession {
  return SLACK.getSession('latchkey');
}

function capturedOf(session: SimpleServiceSession): { token: string; dCookie: string } | null {
  const credentials = session.capturedCredentials;
  if (credentials === null) {
    return null;
  }
  if (!(credentials instanceof SlackApiCredentials)) {
    throw new TypeError('the Slack session should capture Slack credentials');
  }
  return { token: credentials.token, dCookie: credentials.dCookie };
}

describe('slack login from responses', () => {
  it('captures the token and the d cookie from one response', async () => {
    const session = startLogin();
    await session.onResponse(responseWith({ cookieHeader: 'b=1; d=the-d-cookie; x=2' }));
    expect(capturedOf(session)).toEqual({ token: 'xoxc-123-abc', dCookie: 'the-d-cookie' });
  });

  it('ignores responses from outside slack.com', async () => {
    const session = startLogin();
    await session.onResponse(
      responseWith({ url: 'https://evil.example.com/slack.com/', cookieHeader: 'd=nope' })
    );
    await session.onResponse(
      responseWith({ url: 'https://notslack.com/client', cookieHeader: 'd=nope' })
    );
    expect(capturedOf(session)).toBeNull();
  });

  it('is not complete while responses carry no token', async () => {
    const session = startLogin();
    await session.onResponse(responseWith({ body: '<html>signin</html>', cookieHeader: 'd=c' }));
    expect(capturedOf(session)).toBeNull();
  });

  it('is not complete from a token whose request carried no d cookie', async () => {
    const session = startLogin();
    await session.onResponse(responseWith({ cookieHeader: 'other=1' }));
    await session.onResponse(responseWith({}));
    expect(capturedOf(session)).toBeNull();
  });
});

describe('slack login that is stuck', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_TIME);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing while the user is still signing in', async () => {
    const session = startLogin();
    await session.whileWaitingForLogin(pageAt(SIGNIN_URL));
    vi.setSystemTime(START_TIME + WELL_PAST_THE_GRACE_PERIOD_MS);
    await session.whileWaitingForLogin(pageAt(SIGNIN_URL));
    expect(capturedOf(session)).toBeNull();
  });

  // The request may not have carried the cookie, but the browser may well have it.
  it('takes the d cookie from the browser when the request did not carry it', async () => {
    const session = startLogin();
    await session.onResponse(responseWith({}));
    await session.whileWaitingForLogin(
      pageAt(CLIENT_URL, [
        { name: 'd', value: 'from-the-jar', domain: '.slack.com' },
        { name: 'd', value: 'unrelated', domain: 'example.com' },
      ])
    );
    expect(capturedOf(session)).toEqual({ token: 'xoxc-123-abc', dCookie: 'from-the-jar' });
  });

  it('ignores a d cookie of another domain', async () => {
    const session = startLogin();
    await session.onResponse(responseWith({}));
    await session.whileWaitingForLogin(
      pageAt(CLIENT_URL, [{ name: 'd', value: 'unrelated', domain: 'example.com' }])
    );
    expect(capturedOf(session)).toBeNull();
  });

  it('keeps waiting for the d cookie within the grace period', async () => {
    const session = startLogin();
    await session.onResponse(responseWith({}));
    vi.setSystemTime(START_TIME + 1_000);
    await expect(session.whileWaitingForLogin(pageAt(CLIENT_URL))).resolves.toBeUndefined();
  });

  it('gives up on a signed-in browser without a d cookie', async () => {
    const session = startLogin();
    await session.onResponse(responseWith({}));
    vi.setSystemTime(START_TIME + WELL_PAST_THE_GRACE_PERIOD_MS);
    await expect(session.whileWaitingForLogin(pageAt(CLIENT_URL))).rejects.toBeInstanceOf(
      SlackSessionCookieMissingError
    );
  });

  it('gives up on a loaded Slack client that yielded no token', async () => {
    const session = startLogin();
    await session.whileWaitingForLogin(pageAt(CLIENT_URL));
    vi.setSystemTime(START_TIME + WELL_PAST_THE_GRACE_PERIOD_MS);
    await expect(session.whileWaitingForLogin(pageAt(CLIENT_URL))).rejects.toBeInstanceOf(
      SlackTokenMissingError
    );
  });

  it('leaves credentials already captured alone', async () => {
    const session = startLogin();
    await session.onResponse(responseWith({ cookieHeader: 'd=from-response' }));
    await session.whileWaitingForLogin(
      pageAt(CLIENT_URL, [{ name: 'd', value: 'from-the-jar', domain: '.slack.com' }])
    );
    expect(capturedOf(session)).toEqual({ token: 'xoxc-123-abc', dCookie: 'from-response' });
  });
});
