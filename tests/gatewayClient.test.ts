import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildGatewayProxyUrl,
  callLatchkeyEndpoint,
  GatewayCurlRewriteError,
  GatewayRequestError,
  rewriteCurlArgumentsForGateway,
} from '../src/gatewayClient.js';

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
});
