/**
 * A generic login for an MCP server: the OAuth 2.1 authorization code
 * flow with PKCE and dynamic client registration that every such server
 * speaks, configured with the server's endpoints instead of being compiled in
 * as a built-in `-mcp` service.
 *
 * Unlike the capturing flows, this one knows the API it logs into, so it also
 * gives the registered service a credential check (the MCP `initialize`
 * request) and a token refresh.
 *
 * The parameters hold only what nothing else in the registration expresses.
 * The base API URL is implied by the MCP endpoint, so the flow derives it; the
 * authorization endpoint is the page the browser opens, which every flow takes
 * as the service's login URL, so it is `--login-url` rather than a parameter.
 */

import { z } from 'zod';
import type { ApiCredentials } from '../../../apiCredentials/base.js';
import { DEFAULT_ACCOUNT } from '../../../apiCredentials/account.js';
import type { Service, ServiceSession } from '../base.js';
import {
  baseApiUrlOfMcpEndpoint,
  buildMcpInitializeCurlArguments,
  prepareRemoteMcpClient,
  refreshRemoteMcpCredentials,
  RemoteMcpSession,
  type RemoteMcpConnection,
} from '../remoteMcp.js';
import { parseLoginFlowParams, type LoginFlow, type LoginFlowClass } from './base.js';

const McpParamsSchema = z
  .object({
    mcpEndpoint: z.url(),
    tokenEndpoint: z.url(),
    registrationEndpoint: z.url(),
    scopes: z.array(z.string().min(1)).optional(),
    issuesRefreshTokens: z.boolean().optional(),
  })
  .strict();

type McpParams = z.infer<typeof McpParamsSchema>;

function buildConnection(params: McpParams, authorizationEndpoint: string): RemoteMcpConnection {
  return {
    mcpEndpoint: params.mcpEndpoint,
    oauth: {
      authorizationEndpoint,
      tokenEndpoint: params.tokenEndpoint,
      registrationEndpoint: params.registrationEndpoint,
    },
    scopes: params.scopes ?? [],
    issuesRefreshTokens: params.issuesRefreshTokens ?? true,
  };
}

export class McpLoginFlow implements LoginFlow {
  /** Value of `--login-flow`. Not `name`, which every class already has. */
  static readonly flowName = 'mcp';

  static readonly summary = 'Log in to an MCP server (OAuth with dynamic client registration).';

  static readonly details = [
    'Parameters:',
    '  mcpEndpoint           URL that JSON-RPC messages are POSTed to. Required.',
    '  tokenEndpoint         The OAuth token and client registration endpoints,',
    "  registrationEndpoint  as published in the authorization server's",
    '                        /.well-known/oauth-authorization-server. Required.',
    '  scopes                Scopes to request. Defaults to none.',
    '  issuesRefreshTokens   false for a server that issues access tokens only.',
    '                        Defaults to true.',
    '',
    '--login-url is the OAuth authorization endpoint. --base-api-url defaults',
    "to the MCP endpoint's origin. Tokens are refreshed automatically.",
    '',
    'To reuse an existing OAuth client and/or use a redirect URI other than the',
    'loopback one, run `latchkey auth prepare` before logging in:',
    '  $ latchkey auth prepare my-mcp \\',
    '      \'{"redirectUri": "https://example.com/oauth-callback"}\'',
    '',
    'Example:',
    '  $ latchkey services register my-mcp \\',
    '      --login-url="https://mcp.example.com/authorize" \\',
    "      --login-flow=mcp --login-flow-params='{",
    '      "mcpEndpoint": "https://mcp.example.com/mcp",',
    '      "tokenEndpoint": "https://mcp.example.com/token",',
    '      "registrationEndpoint": "https://mcp.example.com/register",',
    '      "scopes": ["read", "write"]}\'',
  ].join('\n');

  static readonly paramsSchema = McpParamsSchema;

  private readonly params: McpParams;

  readonly baseApiUrl: string;
  readonly credentialCheckCurlArguments: readonly string[];

  constructor(rawParams: unknown) {
    this.params = parseLoginFlowParams(McpLoginFlow, rawParams);
    this.baseApiUrl = baseApiUrlOfMcpEndpoint(this.params.mcpEndpoint);
    this.credentialCheckCurlArguments = buildMcpInitializeCurlArguments(this.params.mcpEndpoint);
  }

  describe(loginUrl: string): string {
    return (
      '`latchkey auth browser` registers an OAuth client at ' +
      `${this.params.registrationEndpoint}, authorizes it at ${loginUrl} and stores ` +
      `the resulting tokens for ${this.params.mcpEndpoint}.`
    );
  }

  createSession(service: Service, appNamePrefix: string): ServiceSession {
    // A registered service has no way of asking who logged in, so the account
    // is the user's to name (`--account`); the login itself reports none.
    return new RemoteMcpSession(
      service,
      appNamePrefix,
      buildConnection(this.params, service.loginUrl),
      () => DEFAULT_ACCOUNT
    );
  }

  refreshCredentials(apiCredentials: ApiCredentials): Promise<ApiCredentials | null> {
    return refreshRemoteMcpCredentials(
      { mcpEndpoint: this.params.mcpEndpoint, oauth: { tokenEndpoint: this.params.tokenEndpoint } },
      apiCredentials
    );
  }

  prepareFromJson(serviceName: string, parsedJson: unknown): ApiCredentials {
    return prepareRemoteMcpClient(serviceName, parsedJson);
  }
}

// TypeScript has no `static implements`, so this is where the class side of the
// flow is checked. The registry checks it again, but the error lands here.
McpLoginFlow satisfies LoginFlowClass;
