import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildGatewayProxyUrl,
  callLatchkeyEndpoint,
  GatewayCurlRewriteError,
  GatewayRequestError,
  rewriteCurlArgumentsForGateway,
} from '../src/gateway/client.js';

const GATEWAY_URL = 'http://localhost:8000';

describe('buildGatewayProxyUrl', () => {
  it('concatenates the target URL onto the gateway /gateway/ prefix', () => {
    expect(buildGatewayProxyUrl(GATEWAY_URL, 'https://api.example.com/foo')).toBe(
      'http://localhost:8000/gateway/https://api.example.com/foo'
    );
  });

  it('strips trailing slashes from the gateway base URL', () => {
    expect(buildGatewayProxyUrl(`${GATEWAY_URL}//`, 'https://api.example.com/bar')).toBe(
      'http://localhost:8000/gateway/https://api.example.com/bar'
    );
  });

  it('rewrites latchkey-self.invalid URLs directly onto the gateway base URL', () => {
    expect(
      buildGatewayProxyUrl(GATEWAY_URL, 'https://latchkey-self.invalid/extensions/myorg/hello')
    ).toBe('http://localhost:8000/extensions/myorg/hello');
  });

  it('preserves query strings and fragments when rewriting latchkey-self.invalid URLs', () => {
    expect(
      buildGatewayProxyUrl(
        GATEWAY_URL,
        'https://latchkey-self.invalid:1/extensions/myorg/hello?foo=bar&baz=1#section'
      )
    ).toBe('http://localhost:8000/extensions/myorg/hello?foo=bar&baz=1#section');
  });

  it('does not rewrite hosts that merely contain `latchkey-self.invalid` as a substring', () => {
    expect(
      buildGatewayProxyUrl(GATEWAY_URL, 'https://not-latchkey-self.invalid.example.com/path')
    ).toBe('http://localhost:8000/gateway/https://not-latchkey-self.invalid.example.com/path');
  });
});

describe('rewriteCurlArgumentsForGateway', () => {
  it('replaces the target URL in place with the proxy URL', () => {
    const arguments_ = [
      '-X',
      'POST',
      '-H',
      'Content-Type: application/json',
      'https://slack.com/api/auth.test',
    ];
    const rewritten = rewriteCurlArgumentsForGateway(
      arguments_,
      'https://slack.com/api/auth.test',
      GATEWAY_URL
    );
    expect(rewritten).toEqual([
      '-X',
      'POST',
      '-H',
      'Content-Type: application/json',
      'http://localhost:8000/gateway/https://slack.com/api/auth.test',
    ]);
  });

  it('returns a new array without mutating the input', () => {
    const arguments_ = ['https://api.example.com'];
    const rewritten = rewriteCurlArgumentsForGateway(
      arguments_,
      'https://api.example.com',
      GATEWAY_URL
    );
    expect(rewritten).not.toBe(arguments_);
    expect(arguments_).toEqual(['https://api.example.com']);
  });

  it('throws when the target URL appears more than once', () => {
    const arguments_ = ['https://api.example.com', 'https://api.example.com'];
    expect(() =>
      rewriteCurlArgumentsForGateway(arguments_, 'https://api.example.com', GATEWAY_URL)
    ).toThrow(GatewayCurlRewriteError);
  });

  it('throws when the target URL is not present in the arguments', () => {
    const arguments_ = ['-X', 'POST', 'https://other.example.com'];
    expect(() =>
      rewriteCurlArgumentsForGateway(arguments_, 'https://api.example.com', GATEWAY_URL)
    ).toThrow(GatewayCurlRewriteError);
  });

  it('prepends the gateway password header when a password is provided', () => {
    const rewritten = rewriteCurlArgumentsForGateway(
      ['https://api.example.com'],
      'https://api.example.com',
      GATEWAY_URL,
      'top-secret'
    );
    expect(rewritten).toEqual([
      '-H',
      'x-latchkey-gateway-password: top-secret',
      'http://localhost:8000/gateway/https://api.example.com',
    ]);
  });

  it('does not add a password header when password is null', () => {
    const rewritten = rewriteCurlArgumentsForGateway(
      ['https://api.example.com'],
      'https://api.example.com',
      GATEWAY_URL,
      null
    );
    expect(rewritten).toEqual(['http://localhost:8000/gateway/https://api.example.com']);
  });

  it('prepends the permissions-override header when a JWT is provided', () => {
    const rewritten = rewriteCurlArgumentsForGateway(
      ['https://api.example.com'],
      'https://api.example.com',
      GATEWAY_URL,
      null,
      'jwt.value.here'
    );
    expect(rewritten).toEqual([
      '-H',
      'x-latchkey-gateway-permissions-override: jwt.value.here',
      'http://localhost:8000/gateway/https://api.example.com',
    ]);
  });

  it('rewrites latchkey-self.invalid URLs directly onto the gateway base URL', () => {
    const rewritten = rewriteCurlArgumentsForGateway(
      ['-X', 'GET', 'https://latchkey-self.invalid/extensions/myorg/hello'],
      'https://latchkey-self.invalid/extensions/myorg/hello',
      GATEWAY_URL
    );
    expect(rewritten).toEqual([
      '-X',
      'GET',
      'http://localhost:8000/extensions/myorg/hello',
    ]);
  });

  it('prepends both the password and permissions-override headers when both are provided', () => {
    const rewritten = rewriteCurlArgumentsForGateway(
      ['https://api.example.com'],
      'https://api.example.com',
      GATEWAY_URL,
      'top-secret',
      'jwt.value.here'
    );
    expect(rewritten).toEqual([
      '-H',
      'x-latchkey-gateway-password: top-secret',
      '-H',
      'x-latchkey-gateway-permissions-override: jwt.value.here',
      'http://localhost:8000/gateway/https://api.example.com',
    ]);
  });
});

describe('callLatchkeyEndpoint', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('POSTs the request as JSON to /latchkey and returns the result field', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: ['slack'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await callLatchkeyEndpoint(GATEWAY_URL, {
      command: 'services list',
      params: { builtin: true },
    });

    expect(result).toEqual(['slack']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8000/latchkey');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ command: 'services list', params: { builtin: true } }));
  });

  it('throws GatewayRequestError with the server-supplied message on non-2xx responses', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'unknown command' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as unknown as typeof fetch;

    await expect(
      callLatchkeyEndpoint(GATEWAY_URL, { command: 'services list' })
    ).rejects.toMatchObject({
      name: 'GatewayRequestError',
      message: 'unknown command',
      statusCode: 400,
    });
  });

  it('throws GatewayRequestError when the transport fails', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('connect ECONNREFUSED')) as unknown as typeof fetch;

    await expect(
      callLatchkeyEndpoint(GATEWAY_URL, { command: 'services list' })
    ).rejects.toBeInstanceOf(GatewayRequestError);
  });

  it('sends the gateway password header when configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await callLatchkeyEndpoint(GATEWAY_URL, { command: 'services list' }, 'top-secret');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-latchkey-gateway-password']).toBe('top-secret');
  });

  it('omits the gateway password header when password is null', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await callLatchkeyEndpoint(GATEWAY_URL, { command: 'services list' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect('x-latchkey-gateway-password' in headers).toBe(false);
  });

  it('sends the permissions-override header when configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await callLatchkeyEndpoint(GATEWAY_URL, { command: 'services list' }, null, 'jwt.value.here');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-latchkey-gateway-permissions-override']).toBe('jwt.value.here');
  });

  it('omits the permissions-override header when not configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await callLatchkeyEndpoint(GATEWAY_URL, { command: 'services list' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect('x-latchkey-gateway-permissions-override' in headers).toBe(false);
  });
});
