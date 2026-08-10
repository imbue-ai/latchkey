/**
 * Tests for the generic token-minting browser login used by registered
 * services.
 *
 * The pure pieces (cookie detection, response-field reading) and the network
 * step (minting, with the subprocess runner swapped out) are exercised
 * directly; the flow, its parameters and its wiring onto a RegisteredService go
 * through the same public path a real registration takes.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { ApiCredentials } from '../src/apiCredentials/base.js';
import { resetAsyncSubprocessRunner, setAsyncSubprocessRunner } from '../src/curl.js';
import {
  mintTokenCredentials,
  readTokenField,
  setsCookie,
  TokenMintLoginFlow,
} from '../src/services/core/loginFlows/tokenMint.js';
import {
  formatLoginFlowsHelp,
  LOGIN_FLOWS,
  resolveLoginFlow,
  UnknownLoginFlowError,
} from '../src/services/core/loginFlows/registry.js';
import { LoginFlowParamsInvalidError } from '../src/services/core/loginFlows/base.js';
import { RegisteredService } from '../src/services/core/registered.js';
import { ServiceSession, TELEGRAM } from '../src/services/index.js';

const LOGIN_URL = 'https://oh.example.com/login';
const MINT_URL = 'https://oh.example.com/api/tokens';

async function headerFrom(credentials: ApiCredentials): Promise<string | null> {
  const curlArguments = await credentials.injectIntoCurlCall([]);
  return curlArguments[1] ?? null;
}

/** Record every mint request, and answer with a fixed status + JSON body. */
function stubMint(response: { returncode?: number; stdout?: string; stderr?: string }): {
  calls: (readonly string[])[];
} {
  const calls: (readonly string[])[] = [];
  setAsyncSubprocessRunner((args) => {
    calls.push(args);
    return Promise.resolve({
      returncode: response.returncode ?? 0,
      stdout: Buffer.from(response.stdout ?? ''),
      stderr: response.stderr ?? '',
    });
  });
  return { calls };
}

/** The token-mint params, with `sessionCookie` + `mintUrl` filled in. */
function params(
  overrides: Record<string, unknown> = {}
): Parameters<typeof mintTokenCredentials>[0] {
  // Round-trip through the flow's own schema so the params are exactly what a
  // real registration would produce.
  return TokenMintLoginFlow.paramsSchema.parse({
    sessionCookie: 'session_token',
    mintUrl: MINT_URL,
    ...overrides,
  });
}

afterEach(() => {
  resetAsyncSubprocessRunner();
});

describe('setsCookie', () => {
  it('detects a non-empty assignment to the named cookie', () => {
    expect(setsCookie('session_token=abc123; Path=/; HttpOnly', 'session_token')).toBe(true);
  });

  it('ignores other names, empty values and non-assignments', () => {
    expect(setsCookie('other=abc; Path=/', 'session_token')).toBe(false);
    expect(setsCookie('session_token=; Path=/', 'session_token')).toBe(false);
    expect(setsCookie('not-a-cookie', 'session_token')).toBe(false);
    expect(setsCookie('=orphan', 'session_token')).toBe(false);
  });
});

describe('readTokenField', () => {
  it('reads a top-level field', () => {
    expect(readTokenField({ token: 'abc' }, 'token')).toBe('abc');
  });

  it('reads a dot-path', () => {
    expect(readTokenField({ data: { token: 'deep' } }, 'data.token')).toBe('deep');
  });

  it('returns null for a missing path, a non-string, or an empty string', () => {
    expect(readTokenField({ token: 'abc' }, 'missing')).toBeNull();
    expect(readTokenField({ token: 123 }, 'token')).toBeNull();
    expect(readTokenField({ token: '' }, 'token')).toBeNull();
    expect(readTokenField('not-an-object', 'token')).toBeNull();
  });
});

describe('mintTokenCredentials', () => {
  it('mints and stores the token as a bearer header by default', async () => {
    const { calls } = stubMint({ stdout: JSON.stringify({ token: 'secret-token' }) });
    const credentials = await mintTokenCredentials(params(), 'session_token=abc', 'my-app');
    expect(await headerFrom(credentials)).toBe('Authorization: Bearer secret-token');

    // The request is a same-origin POST carrying the session cookie.
    const args = calls[0]!;
    expect(args).toContain(MINT_URL);
    expect(args).toContain('POST');
    expect(args).toContain('Cookie: session_token=abc');
    expect(args).toContain(`Origin: https://oh.example.com`);
  });

  it('writes a generated name into the body when nameField is set', async () => {
    const { calls } = stubMint({ stdout: JSON.stringify({ token: 't' }) });
    await mintTokenCredentials(
      params({ mintBody: { expiry_hours: 'never' }, nameField: 'name' }),
      'session_token=abc',
      'chosen-name'
    );
    const dataIndex = calls[0]!.indexOf('--data');
    const body = JSON.parse(calls[0]![dataIndex + 1]!) as Record<string, unknown>;
    expect(body).toEqual({ expiry_hours: 'never', name: 'chosen-name' });
  });

  it('honours a custom token field, header and prefix', async () => {
    stubMint({ stdout: JSON.stringify({ data: { key: 'k' } }) });
    const credentials = await mintTokenCredentials(
      params({ tokenField: 'data.key', header: 'X-Api-Key', valuePrefix: '' }),
      'session_token=abc',
      'app'
    );
    expect(await headerFrom(credentials)).toBe('X-Api-Key: k');
  });

  it('fails when curl fails, the body is not JSON, or the token is absent', async () => {
    stubMint({ returncode: 7, stderr: 'connection refused' });
    await expect(mintTokenCredentials(params(), 'session_token=abc', 'app')).rejects.toThrow(
      /Minting an API token failed/
    );

    stubMint({ stdout: '<html>nope</html>' });
    await expect(mintTokenCredentials(params(), 'session_token=abc', 'app')).rejects.toThrow(
      /did not return JSON/
    );

    stubMint({ stdout: JSON.stringify({ nope: 1 }) });
    await expect(mintTokenCredentials(params(), 'session_token=abc', 'app')).rejects.toThrow(
      /No token found/
    );
  });
});

describe('the token-mint flow in the registry', () => {
  it('is registered and documents itself in the register help', () => {
    expect(LOGIN_FLOWS.map((flow) => flow.flowName)).toContain('token-mint');
    const help = formatLoginFlowsHelp();
    expect(help).toContain('token-mint');
    expect(help).toContain(TokenMintLoginFlow.summary);
  });

  it('rejects parameters that do not match the schema', () => {
    const invalidParameterSets = [
      {},
      { sessionCookie: 'session_token' }, // no mintUrl
      { mintUrl: MINT_URL }, // no sessionCookie
      { sessionCookie: 'session_token', mintUrl: 'not-a-url' },
      { sessionCookie: 'session_token', mintUrl: MINT_URL, mintMethod: 'GET' },
      { sessionCookie: 'session_token', mintUrl: MINT_URL, typo: true },
    ];
    for (const invalid of invalidParameterSets) {
      expect(() => resolveLoginFlow('token-mint', invalid)).toThrow(LoginFlowParamsInvalidError);
    }
  });

  it('accepts valid parameters and describes itself', () => {
    const flow = resolveLoginFlow('token-mint', {
      sessionCookie: 'session_token',
      mintUrl: MINT_URL,
    });
    const description = flow.describe(LOGIN_URL);
    expect(description).toContain(LOGIN_URL);
    expect(description).toContain(MINT_URL);
    expect(description).toContain('session_token');
  });

  it('is unknown under any other name', () => {
    expect(() => resolveLoginFlow('mint-token', {})).toThrow(UnknownLoginFlowError);
  });
});

describe('RegisteredService with the token-mint flow', () => {
  const mintFlow = () =>
    resolveLoginFlow('token-mint', { sessionCookie: 'session_token', mintUrl: MINT_URL });

  it('exposes the flow as its browser login', () => {
    const service = new RegisteredService('my-openhost', 'https://oh.example.com/api/', {
      loginUrl: LOGIN_URL,
      loginFlow: mintFlow(),
    });
    expect(service.getSession).toBeDefined(); // eslint-disable-line @typescript-eslint/unbound-method
    expect(service.getSession!('latchkey')).toBeInstanceOf(ServiceSession);
    expect(service.info).toContain(LOGIN_URL);
    expect(service.info).toContain(MINT_URL);
  });

  it('rejects a family service alongside the flow at compile time', () => {
    const service = new RegisteredService('my-openhost', 'https://oh.example.com/api/', {
      familyService: TELEGRAM,
      loginUrl: LOGIN_URL,
      // @ts-expect-error -- a family service brings its own login
      loginFlow: mintFlow(),
    });
    expect(service.getSession).toBeUndefined(); // eslint-disable-line @typescript-eslint/unbound-method
  });
});
