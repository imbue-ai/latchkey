import { describe, it, expect, afterEach } from 'vitest';
import { AuthorizationBearer, OAuthCredentials } from '../src/apiCredentials/base.js';
import { tryParseJson } from '../src/apiCredentials/account.js';
import { resetAsyncSubprocessRunner, setAsyncSubprocessRunner } from '../src/curl.js';
import {
  buildAuthorizationState,
  buildAuthorizationUrl,
  buildClientRegistrationBody,
  buildMcpInitializeCurlArguments,
  extractMcpToolResultTexts,
  fetchAccountFromMcpTool,
  parseMcpResponseBody,
  RemoteMcpService,
} from '../src/services/core/remoteMcp.js';
import { BUILTIN_SERVICES } from '../src/serviceRegistry.js';

describe('buildAuthorizationState', () => {
  it('puts the loopback port in the last dot-separated segment', () => {
    const state = buildAuthorizationState(54321);

    expect(state.split('.').pop()).toBe('54321');
  });

  it('prefixes the port with an unguessable value', () => {
    const state = buildAuthorizationState(54321);
    const [prefix] = state.split('.');

    // A UUID, i.e. long enough that a redirect cannot be forged by guessing.
    expect(prefix).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(buildAuthorizationState(54321)).not.toBe(state);
  });
});

describe('buildClientRegistrationBody', () => {
  it('registers a public client for the authorization code flow with refresh', () => {
    expect(
      buildClientRegistrationBody('http://localhost:1234/oauth2callback', 'latchkey-01-01-ab', [])
    ).toEqual({
      client_name: 'latchkey-01-01-ab',
      redirect_uris: ['http://localhost:1234/oauth2callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  it('asks for the scopes when the service has some', () => {
    const body = buildClientRegistrationBody('http://localhost:1/cb', 'name', ['read', 'write']);

    expect(body.scope).toBe('read write');
  });
});

describe('buildAuthorizationUrl', () => {
  const request = {
    clientId: 'client-1',
    redirectUri: 'http://localhost:1234/oauth2callback',
    codeChallenge: 'challenge',
    state: 'uuid.1234',
    scopes: [] as readonly string[],
    resource: 'https://mcp.example.com/mcp',
  };

  it('carries PKCE, state and the resource the token is for', () => {
    const url = new URL(buildAuthorizationUrl('https://mcp.example.com/authorize', request));

    expect(url.origin + url.pathname).toBe('https://mcp.example.com/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'client-1',
      redirect_uri: 'http://localhost:1234/oauth2callback',
      response_type: 'code',
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
      state: 'uuid.1234',
      resource: 'https://mcp.example.com/mcp',
    });
  });

  it('adds the scopes space-separated when there are some', () => {
    const url = new URL(
      buildAuthorizationUrl('https://mcp.example.com/authorize', {
        ...request,
        scopes: ['activity:read', 'profile:read_all'],
      })
    );

    expect(url.searchParams.get('scope')).toBe('activity:read profile:read_all');
  });

  it('keeps query parameters the authorization endpoint already has', () => {
    const url = new URL(
      buildAuthorizationUrl('https://mcp.example.com/authorize?audience=api', request)
    );

    expect(url.searchParams.get('audience')).toBe('api');
    expect(url.searchParams.get('client_id')).toBe('client-1');
  });
});

describe('buildMcpInitializeCurlArguments', () => {
  it('POSTs an initialize request accepting both JSON and SSE', () => {
    const curlArguments = buildMcpInitializeCurlArguments('https://mcp.example.com/mcp');

    expect(curlArguments[curlArguments.length - 1]).toBe('https://mcp.example.com/mcp');
    expect(curlArguments).toContain('Accept: application/json, text/event-stream');
    const payload = JSON.parse(curlArguments[curlArguments.indexOf('-d') + 1]!) as {
      method: string;
    };
    expect(payload.method).toBe('initialize');
  });
});

describe('parseMcpResponseBody', () => {
  it('reads a plain JSON-RPC body', () => {
    expect(parseMcpResponseBody('{"jsonrpc":"2.0","id":1,"result":{}}')).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {},
    });
  });

  it('reads the last JSON-RPC message out of an SSE stream', () => {
    const body = 'event: message\ndata: {"id":0}\n\nevent: message\ndata: {"id":1}\n';

    expect(parseMcpResponseBody(body)).toEqual({ id: 1 });
  });

  it('yields null on garbage', () => {
    expect(parseMcpResponseBody('not json')).toBeNull();
    expect(parseMcpResponseBody('data: not json')).toBeNull();
  });
});

describe('extractMcpToolResultTexts', () => {
  it('collects the text parts of a tool result, skipping other kinds', () => {
    const body = JSON.stringify({
      result: {
        content: [
          { type: 'text', text: 'first' },
          { type: 'image', data: '...' },
          { type: 'text', text: 'second' },
        ],
      },
    });

    expect(extractMcpToolResultTexts(body)).toEqual(['first', 'second']);
  });

  it('yields nothing for an error response', () => {
    expect(extractMcpToolResultTexts('{"error":{"code":-32600}}')).toEqual([]);
  });
});

describe('fetchAccountFromMcpTool', () => {
  afterEach(() => {
    resetAsyncSubprocessRunner();
  });

  it('calls the tool with the bearer token and parses the first text that names an account', async () => {
    let observedArguments: readonly string[] = [];
    setAsyncSubprocessRunner((args) => {
      observedArguments = args;
      const body = JSON.stringify({
        result: {
          content: [
            { type: 'text', text: 'preamble' },
            { type: 'text', text: '{"email":"jane@example.com"}' },
          ],
        },
      });
      return Promise.resolve({ returncode: 0, stdout: Buffer.from(body), stderr: '' });
    });

    const account = await fetchAccountFromMcpTool(
      new AuthorizationBearer('token-1'),
      'https://mcp.example.com/mcp',
      'whoami',
      {},
      (text) => (tryParseJson(text) as { email?: string } | null)?.email ?? null
    );

    expect(account).toBe('jane@example.com');
    expect(observedArguments).toContain('Authorization: Bearer token-1');
    expect(observedArguments[observedArguments.length - 1]).toBe('https://mcp.example.com/mcp');
    const payload = JSON.parse(observedArguments[observedArguments.indexOf('-d') + 1]!) as {
      method: string;
      params: { name: string };
    };
    expect(payload.method).toBe('tools/call');
    expect(payload.params.name).toBe('whoami');
  });

  it('leaves the account undetermined for token-less prepared credentials', async () => {
    const account = await fetchAccountFromMcpTool(
      new OAuthCredentials('client-id', ''),
      'https://mcp.example.com/mcp',
      'whoami',
      {},
      () => 'never'
    );

    expect(account).toBeNull();
  });
});

const REMOTE_MCP_SERVICES = BUILTIN_SERVICES.filter(
  (service): service is RemoteMcpService => service instanceof RemoteMcpService
);

describe('built-in remote MCP services', () => {
  it('exist', () => {
    expect(REMOTE_MCP_SERVICES.length).toBeGreaterThan(0);
  });

  it.each(REMOTE_MCP_SERVICES.map((service) => [service.name, service] as const))(
    '%s is consistently defined',
    (_name, service) => {
      const { definition } = service;

      expect(service.name).toMatch(/^[a-z0-9][a-z0-9-]*-mcp$/);
      expect(service.displayName).toMatch(/ MCP$/);

      for (const url of [
        definition.mcpEndpoint,
        definition.oauth.authorizationEndpoint,
        definition.oauth.tokenEndpoint,
        definition.oauth.registrationEndpoint,
      ]) {
        expect(new URL(url).protocol).toBe('https:');
      }

      // Calls to the MCP endpoint itself must be recognized as this service's.
      expect(service.baseApiUrls[0]).toBe(`${new URL(definition.mcpEndpoint).origin}/`);
      expect(service.loginUrl).toBe(definition.oauth.authorizationEndpoint);

      // The credential check talks to the MCP endpoint.
      expect(
        service.credentialCheckCurlArguments[service.credentialCheckCurlArguments.length - 1]
      ).toBe(definition.mcpEndpoint);

      // Info is for agents: concise, and either points at docs or at tools/list.
      expect(service.info.length).toBeGreaterThan(20);
      expect(service.info.length).toBeLessThan(700);
      expect(service.info).toMatch(/https:\/\/|tools\/list/);

      expect(service.setCredentialsExample(service.name)).toContain('Authorization: Bearer');
    }
  );

  it('have distinct names and MCP endpoints', () => {
    const names = REMOTE_MCP_SERVICES.map((service) => service.name);
    expect(new Set(names).size).toBe(names.length);

    const endpoints = REMOTE_MCP_SERVICES.map((service) => service.definition.mcpEndpoint);
    expect(new Set(endpoints).size).toBe(endpoints.length);
  });

  it('accept a prepared client id and refuse a secret', () => {
    const [service] = REMOTE_MCP_SERVICES;
    const prepared = service!.prepareFromJson({ clientId: 'client-1' }) as OAuthCredentials;

    expect(prepared).toBeInstanceOf(OAuthCredentials);
    expect(prepared.clientId).toBe('client-1');
    expect(prepared.clientSecret).toBe('');
    expect(() => service!.prepareFromJson({ clientId: 'c', clientSecret: 's' })).toThrow();
  });

  it('do not refresh credentials that have no refresh token', async () => {
    const [service] = REMOTE_MCP_SERVICES;

    expect(await service!.refreshCredentials(new AuthorizationBearer('t'))).toBeNull();
    expect(await service!.refreshCredentials(new OAuthCredentials('c', '', 'access'))).toBeNull();
  });
});
