/**
 * Tests for the claude.ai and ChatGPT services.
 *
 * Both go through the public path a real login takes — the service's own
 * session, fed the responses a browser would have produced — so what is under
 * test is the credential a login actually yields, not an internal helper.
 */

import { describe, it, expect } from 'vitest';
import type { Response } from 'playwright';
import type { ApiCredentials } from '../src/apiCredentials/base.js';
import type { ServiceSession } from '../src/services/index.js';
import { CLAUDE_AI, CHATGPT } from '../src/services/index.js';
import { SERVICE_REGISTRY } from '../src/serviceRegistry.js';

/** A response carrying only `Set-Cookie` headers, as cookie-capture reads it. */
function responseWithCookies(setCookieHeaders: readonly string[], url: string): Response {
  return {
    url: () => url,
    headersArray: () =>
      Promise.resolve([
        { name: 'Content-Type', value: 'text/html' },
        ...setCookieHeaders.map((value) => ({ name: 'set-cookie', value })),
      ]),
  } as unknown as Response;
}

/** A response carrying a JSON body, as the ChatGPT session reads it. */
function responseWithJsonBody(body: unknown, url: string): Response {
  return {
    url: () => url,
    text: () => Promise.resolve(JSON.stringify(body)),
    headersArray: () => Promise.resolve([]),
  } as unknown as Response;
}

/**
 * The curl arguments a login's credentials would inject, or null when the
 * session has not captured anything yet.
 */
async function injectedArgumentsFrom(session: ServiceSession): Promise<readonly string[] | null> {
  const credentials = (session as unknown as { capturedCredentials: ApiCredentials | null })
    .capturedCredentials;
  return credentials === null ? null : await credentials.injectIntoCurlCall([]);
}

describe('claude-ai', () => {
  it('captures the sessionKey cookie as a Cookie header', async () => {
    const session = CLAUDE_AI.getSession('test');

    await session.onResponse(
      responseWithCookies(
        ['sessionKey=sk-ant-sid01-abc; Domain=claude.ai; Path=/; HttpOnly'],
        'https://claude.ai/api/auth/login'
      )
    );

    expect(await injectedArgumentsFrom(session)).toEqual([
      '-H',
      'Cookie: sessionKey=sk-ant-sid01-abc',
    ]);
  });

  it('produces exactly what `auth set -H "Cookie: sessionKey=..."` would', async () => {
    // The point of the built-in service is that a browser login and the
    // hand-rolled `auth set` a user runs today are interchangeable; datalib
    // consumes the header either way.
    const session = CLAUDE_AI.getSession('test');
    await session.onResponse(
      responseWithCookies(
        ['sessionKey=value-under-test; Domain=claude.ai; Path=/'],
        'https://claude.ai/'
      )
    );

    const injected = await injectedArgumentsFrom(session);
    expect(injected?.[1]).toBe('Cookie: sessionKey=value-under-test');
  });

  it('ignores cookies set for other domains along the way', async () => {
    const session = CLAUDE_AI.getSession('test');

    await session.onResponse(
      responseWithCookies(
        ['sessionKey=from-somewhere-else; Domain=example.com; Path=/'],
        'https://example.com/sso'
      )
    );

    expect(await injectedArgumentsFrom(session)).toBeNull();
  });

  it('claims the claude.ai origin but not the Anthropic developer API', () => {
    expect(SERVICE_REGISTRY.getByUrl('https://claude.ai/api/organizations')).toBe(CLAUDE_AI);
    expect(SERVICE_REGISTRY.getByUrl('https://api.anthropic.com/v1/messages')).toBeNull();
  });
});

describe('chatgpt', () => {
  it('lifts accessToken out of the session response as a bearer token', async () => {
    const session = CHATGPT.getSession('test');

    await session.onResponse(
      responseWithJsonBody(
        { user: { email: 'someone@example.com' }, accessToken: 'eyJhbGciOi-test' },
        'https://chatgpt.com/api/auth/session'
      )
    );

    expect(await injectedArgumentsFrom(session)).toEqual([
      '-H',
      'Authorization: Bearer eyJhbGciOi-test',
    ]);
  });

  it('does not capture the signed-out session response', async () => {
    // A visitor who is not signed in gets the same endpoint answering `{}`;
    // treating the request itself as the signal would end the login with no
    // usable credential.
    const session = CHATGPT.getSession('test');

    await session.onResponse(responseWithJsonBody({}, 'https://chatgpt.com/api/auth/session'));

    expect(await injectedArgumentsFrom(session)).toBeNull();
  });

  it('ignores responses from other endpoints', async () => {
    const session = CHATGPT.getSession('test');

    await session.onResponse(
      responseWithJsonBody({ accessToken: 'not-from-the-session-endpoint' }, 'https://chatgpt.com/')
    );

    expect(await injectedArgumentsFrom(session)).toBeNull();
  });

  it('claims the backend API but not the web app or the OpenAI platform API', () => {
    expect(SERVICE_REGISTRY.getByUrl('https://chatgpt.com/backend-api/me')).toBe(CHATGPT);
    expect(SERVICE_REGISTRY.getByUrl('https://chatgpt.com/c/some-conversation')).toBeNull();
    expect(SERVICE_REGISTRY.getByUrl('https://api.openai.com/v1/models')).toBeNull();
  });
});

describe('both services', () => {
  it('offer a browser login', () => {
    // `services info` reports `browser` in authOptions when a service hands
    // out a session, and that is what makes the credential screen a Connect
    // button rather than a paste-a-token field.
    expect(CLAUDE_AI.getSession('test')).not.toBeNull();
    expect(CHATGPT.getSession('test')).not.toBeNull();
  });
});
