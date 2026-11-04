/**
 * Tests for the `mcp` login flow of registered services: what it
 * derives from its parameters, and what it adds to the service beyond the
 * browser login (the credential check and the token refresh).
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  AuthorizationBearer,
  ApiCredentialStatus,
  OAuthCredentials,
} from '../src/apiCredentials/base.js';
import { resetAsyncSubprocessRunner, setAsyncSubprocessRunner } from '../src/curl.js';
import { LoginFlowParamsInvalidError } from '../src/services/core/loginFlows/base.js';
import { LOGIN_FLOWS, resolveLoginFlow } from '../src/services/core/loginFlows/registry.js';
import { McpLoginFlow } from '../src/services/core/loginFlows/mcp.js';
import { RegisteredService } from '../src/services/core/registered.js';
import { RemoteMcpSession } from '../src/services/core/remoteMcp.js';

const AUTHORIZATION_ENDPOINT = 'https://auth.example.com/authorize';
const PARAMS = {
  mcpEndpoint: 'https://mcp.example.com/mcp',
  tokenEndpoint: 'https://auth.example.com/token',
  registrationEndpoint: 'https://auth.example.com/register',
};

function registerService(flow: McpLoginFlow): RegisteredService {
  return new RegisteredService('my-mcp', flow.baseApiUrl, {
    loginFlow: flow,
    loginUrl: AUTHORIZATION_ENDPOINT,
  });
}

describe('McpLoginFlow', () => {
  afterEach(() => {
    resetAsyncSubprocessRunner();
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
    const { registrationEndpoint: _dropped, ...withoutRegistration } = PARAMS;

    expect(() => new McpLoginFlow(withoutRegistration)).toThrow(LoginFlowParamsInvalidError);
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

  it('leaves the capturing flows without a check or a refresh', () => {
    const service = new RegisteredService('my-service', 'https://app.example.com/api/', {
      loginUrl: 'https://app.example.com/login',
      loginFlow: resolveLoginFlow('cookie-capture', { cookieKeys: ['sessionid'] }),
    });

    expect('refreshCredentials' in service).toBe(false);
    expect(service.credentialCheckCurlArguments).toEqual([]);
  });
});
