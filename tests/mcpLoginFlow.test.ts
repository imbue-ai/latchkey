/**
 * Tests for the `mcp` login flow of registered services: what it
 * derives from its parameters, and what it adds to the service beyond the
 * browser login (the credential check and the token refresh).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  AuthorizationBearer,
  ApiCredentialStatus,
  OAuthCredentials,
} from '../src/apiCredentials/base.js';
import { resetAsyncSubprocessRunner, setAsyncSubprocessRunner } from '../src/curl.js';
import { EncryptedStorage } from '../src/encryptedStorage.js';
import { LoginFailedError, PrepareInputInvalidError } from '../src/services/core/base.js';
import { LoginFlowParamsInvalidError } from '../src/services/core/loginFlows/base.js';
import { LOGIN_FLOWS, resolveLoginFlow } from '../src/services/core/loginFlows/registry.js';
import { McpLoginFlow } from '../src/services/core/loginFlows/mcp.js';
import { RegisteredService } from '../src/services/core/registered.js';
import { RemoteMcpSession } from '../src/services/core/remoteMcp.js';
import * as systemBrowser from '../src/systemBrowser.js';

const AUTHORIZATION_ENDPOINT = 'https://auth.example.com/authorize';
const PARAMS = {
  mcpEndpoint: 'https://mcp.example.com/mcp',
  tokenEndpoint: 'https://auth.example.com/token',
  registrationEndpoint: 'https://auth.example.com/register',
};
const { registrationEndpoint: _registrationEndpoint, ...PARAMS_WITHOUT_REGISTRATION } = PARAMS;
const TEST_ENCRYPTION_KEY = 'dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleXRlc3Q=';

function registerService(flow: McpLoginFlow): RegisteredService {
  return new RegisteredService('my-mcp', flow.baseApiUrl, {
    loginFlow: flow,
    loginUrl: AUTHORIZATION_ENDPOINT,
  });
}

describe('McpLoginFlow', () => {
  afterEach(() => {
    resetAsyncSubprocessRunner();
    vi.restoreAllMocks();
  });

  it('is available under the name --login-flow takes', () => {
    expect(LOGIN_FLOWS).toContain(McpLoginFlow);
    expect(resolveLoginFlow('mcp', PARAMS)).toBeInstanceOf(McpLoginFlow);
  });

  it('derives the base API URL from the MCP endpoint', () => {
    const flow = new McpLoginFlow(PARAMS);

    expect(flow.baseApiUrl).toBe('https://mcp.example.com/');
  });

  it('rejects parameters that are missing, malformed, or unknown', () => {
    const { tokenEndpoint: _dropped, ...withoutToken } = PARAMS;

    expect(() => new McpLoginFlow(withoutToken)).toThrow(LoginFlowParamsInvalidError);
    expect(() => new McpLoginFlow({ ...PARAMS, registrationEndpoint: 'not a url' })).toThrow(
      LoginFlowParamsInvalidError
    );
    expect(() => new McpLoginFlow({ ...PARAMS, mcpEndpoint: 'not a url' })).toThrow(
      LoginFlowParamsInvalidError
    );
    expect(
      () => new McpLoginFlow({ ...PARAMS, authorizationEndpoint: AUTHORIZATION_ENDPOINT })
    ).toThrow(LoginFlowParamsInvalidError);
    expect(() => new McpLoginFlow({ ...PARAMS, scopes: [''] })).toThrow(
      LoginFlowParamsInvalidError
    );
  });

  it('describes the login in terms of its endpoints', () => {
    const flow = new McpLoginFlow(PARAMS);

    const description = flow.describe(AUTHORIZATION_ENDPOINT);

    expect(description).toContain(PARAMS.registrationEndpoint);
    expect(description).toContain(AUTHORIZATION_ENDPOINT);
    expect(description).toContain(PARAMS.mcpEndpoint);
  });

  it('describes a login without a registration endpoint as using a prepared client', () => {
    const flow = new McpLoginFlow(PARAMS_WITHOUT_REGISTRATION);

    expect(flow.describe(AUTHORIZATION_ENDPOINT)).toContain('latchkey auth prepare');
  });

  it('hands the registered service a remote MCP session', () => {
    const service = registerService(new McpLoginFlow(PARAMS));

    expect(service.getSession!('latchkey')).toBeInstanceOf(RemoteMcpSession);
    expect(service.info).toContain(PARAMS.mcpEndpoint);
  });

  it('checks credentials with an MCP initialize request', async () => {
    const service = registerService(new McpLoginFlow(PARAMS));
    let observedArguments: readonly string[] = [];
    setAsyncSubprocessRunner((args) => {
      observedArguments = args;
      return Promise.resolve({ returncode: 0, stdout: Buffer.from('{}\n200'), stderr: '' });
    });

    expect(await service.checkApiCredentials(new AuthorizationBearer('token-1'))).toBe(
      ApiCredentialStatus.Valid
    );
    expect(observedArguments).toContain('Authorization: Bearer token-1');
    expect(observedArguments[observedArguments.length - 1]).toBe(PARAMS.mcpEndpoint);
    const payload = JSON.parse(observedArguments[observedArguments.indexOf('-d') + 1]!) as {
      method: string;
    };
    expect(payload.method).toBe('initialize');

    setAsyncSubprocessRunner(() =>
      Promise.resolve({ returncode: 0, stdout: Buffer.from('\n401'), stderr: '' })
    );
    expect(await service.checkApiCredentials(new AuthorizationBearer('stale'))).toBe(
      ApiCredentialStatus.Invalid
    );
  });

  it('refreshes the access token at the token endpoint, naming the MCP endpoint as the resource', async () => {
    const service = registerService(new McpLoginFlow(PARAMS));
    let observedArguments: readonly string[] = [];
    setAsyncSubprocessRunner((args) => {
      observedArguments = args;
      const body = JSON.stringify({ access_token: 'fresh', refresh_token: 'r2', expires_in: 3600 });
      return Promise.resolve({ returncode: 0, stdout: Buffer.from(body), stderr: '' });
    });

    const refreshed = (await service.refreshCredentials!(
      new OAuthCredentials('client-1', '', 'stale', 'r1')
    )) as OAuthCredentials;

    expect(refreshed.accessToken).toBe('fresh');
    expect(refreshed.refreshToken).toBe('r2');
    expect(refreshed.clientId).toBe('client-1');
    expect(observedArguments[observedArguments.length - 1]).toBe(PARAMS.tokenEndpoint);
    const body = new URLSearchParams(observedArguments[observedArguments.indexOf('-d') + 1]);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('r1');
    expect(body.get('resource')).toBe(PARAMS.mcpEndpoint);
  });

  it('does not refresh credentials that carry no refresh token', async () => {
    const service = registerService(new McpLoginFlow(PARAMS));

    expect(await service.refreshCredentials!(new AuthorizationBearer('t'))).toBeNull();
  });

  it('accepts a prepared redirect URI and client id via auth prepare', () => {
    const service = registerService(new McpLoginFlow(PARAMS));

    const prepared = service.prepareFromJson!({
      clientId: 'client-1',
      redirectUri: 'https://example.com/oauth-callback',
    });

    expect(prepared).toBeInstanceOf(OAuthCredentials);
    expect((prepared as OAuthCredentials).clientId).toBe('client-1');
    expect((prepared as OAuthCredentials).redirectUri).toBe('https://example.com/oauth-callback');
  });

  it('rejects invalid prepare input, naming the registered service', () => {
    const service = registerService(new McpLoginFlow(PARAMS));

    expect(() => service.prepareFromJson!({ redirectUri: 'not a url' })).toThrow(
      PrepareInputInvalidError
    );
    expect(() => service.prepareFromJson!({ redirectUri: 'not a url' })).toThrow(/my-mcp/);
  });

  it('accepts a Client ID Metadata Document URL as the client id', () => {
    const service = registerService(new McpLoginFlow(PARAMS_WITHOUT_REGISTRATION));

    const prepared = service.prepareFromJson!({
      clientId: 'https://example.com/oauth-client.json',
    }) as OAuthCredentials;

    expect(prepared.clientId).toBe('https://example.com/oauth-client.json');
  });

  it.each([
    ['is not https', 'http://example.com/oauth-client.json'],
    ['has no path', 'https://example.com'],
    ['has a fragment', 'https://example.com/oauth-client.json#fragment'],
    ['has credentials', 'https://user:password@example.com/oauth-client.json'],
    ['does not parse', 'https://'],
  ])('rejects a client id URL that %s', (_reason, clientId) => {
    const service = registerService(new McpLoginFlow(PARAMS));

    expect(() => service.prepareFromJson!({ clientId })).toThrow(PrepareInputInvalidError);
  });

  it('refuses to log in without a registration endpoint or a prepared client id', async () => {
    const service = registerService(new McpLoginFlow(PARAMS_WITHOUT_REGISTRATION));
    const openInSystemBrowser = vi
      .spyOn(systemBrowser, 'openInSystemBrowser')
      .mockResolvedValue(undefined);

    const login = service.getSession!('latchkey').login(
      new EncryptedStorage(TEST_ENCRYPTION_KEY),
      {},
      OAuthCredentials.prepared('', '', 'https://example.com/oauth-callback'),
      { systemBrowser: true }
    );

    await expect(login).rejects.toThrow(LoginFailedError);
    await expect(login).rejects.toThrow(/latchkey auth prepare my-mcp/);
    expect(openInSystemBrowser).not.toHaveBeenCalled();
  });

  it('logs in with a prepared Client ID Metadata Document URL instead of registering', async () => {
    const clientId = 'https://example.com/oauth-client.json';
    const redirectUri = 'https://example.com/oauth-callback';
    const service = registerService(new McpLoginFlow(PARAMS_WITHOUT_REGISTRATION));
    let authorizationUrl: URL | undefined;
    // Stands in for the user approving and the prepared redirect page
    // forwarding the code to the loopback port named in the state.
    vi.spyOn(systemBrowser, 'openInSystemBrowser').mockImplementation(async (url) => {
      authorizationUrl = new URL(url);
      const state = authorizationUrl.searchParams.get('state')!;
      const port = state.split('.').pop()!;
      // The callback server listens on whichever address family `localhost`
      // resolves to first; a browser tries both, and so does this.
      await Promise.any(
        ['127.0.0.1', '[::1]'].map((host) =>
          fetch(`http://${host}:${port}/oauth2callback?code=code-1&state=${state}`)
        )
      );
    });
    const requestedUrls: string[] = [];
    let tokenRequestBody = new URLSearchParams();
    setAsyncSubprocessRunner((args) => {
      requestedUrls.push(args[args.length - 1]!);
      tokenRequestBody = new URLSearchParams(args[args.indexOf('-d') + 1]);
      const body = JSON.stringify({ access_token: 'access-1', refresh_token: 'refresh-1' });
      return Promise.resolve({ returncode: 0, stdout: Buffer.from(body), stderr: '' });
    });

    const result = await service.getSession!('latchkey').login(
      new EncryptedStorage(TEST_ENCRYPTION_KEY),
      {},
      OAuthCredentials.prepared(clientId, '', redirectUri),
      { systemBrowser: true }
    );

    expect(authorizationUrl?.searchParams.get('client_id')).toBe(clientId);
    expect(authorizationUrl?.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(requestedUrls).toEqual([PARAMS.tokenEndpoint]);
    expect(tokenRequestBody.get('client_id')).toBe(clientId);
    expect(tokenRequestBody.get('redirect_uri')).toBe(redirectUri);
    expect(tokenRequestBody.has('client_secret')).toBe(false);
    const credentials = result.credentials as OAuthCredentials;
    expect(credentials.clientId).toBe(clientId);
    expect(credentials.accessToken).toBe('access-1');
    expect(credentials.redirectUri).toBe(redirectUri);
  });

  it('leaves the capturing flows without a check, a refresh, or a preparation', () => {
    const service = new RegisteredService('my-service', 'https://app.example.com/api/', {
      loginUrl: 'https://app.example.com/login',
      loginFlow: resolveLoginFlow('cookie-capture', { cookieKeys: ['sessionid'] }),
    });

    expect('refreshCredentials' in service).toBe(false);
    expect('prepareFromJson' in service).toBe(false);
    expect(service.credentialCheckCurlArguments).toEqual([]);
  });
});
