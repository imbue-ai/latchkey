/**
 * Buildkite MCP service: the remote MCP server Buildkite hosts at
 * mcp.buildkite.com, behind its own OAuth 2.1 authorization server. The
 * endpoints come from https://mcp.buildkite.com/.well-known/oauth-authorization-server.
 */

import type { ApiCredentials } from '../apiCredentials/base.js';
import { tryParseJson } from '../apiCredentials/account.js';
import { fetchAccountFromMcpTool, RemoteMcpService } from './core/remoteMcp.js';

const MCP_ENDPOINT = 'https://mcp.buildkite.com/mcp';

/**
 * Extract the account from a `current_user` tool result, which relays the
 * REST API's "Get the current user" response, e.g. `{"id":"...","name":"Jane
 * Doe","email":"jane@example.com",...}`.
 */
function parseAccountFromCurrentUserResult(toolResultText: string): string | null {
  const currentUser = tryParseJson(toolResultText) as { email?: string; name?: string } | null;
  return currentUser?.email ?? currentUser?.name ?? null;
}

export class BuildkiteMcp extends RemoteMcpService {
  constructor() {
    super({
      name: 'buildkite-mcp',
      displayName: 'Buildkite MCP',
      mcpEndpoint: MCP_ENDPOINT,
      oauth: {
        authorizationEndpoint: 'https://mcp.buildkite.com/oauth/authorize',
        tokenEndpoint: 'https://mcp.buildkite.com/oauth/token',
        registrationEndpoint: 'https://mcp.buildkite.com/oauth/register',
      },
      scopes: ['read', 'write'],
      info:
        'https://buildkite.com/docs/apis/mcp-server/tools (tool catalog). ' +
        'https://buildkite.com/docs/apis/mcp-server/tools/toolsets (toolsets and URL variants). ' +
        'The same token works against the read-only variant https://mcp.buildkite.com/mcp/readonly ' +
        'and single toolsets at https://mcp.buildkite.com/mcp/x/<toolset>[/readonly]. ' +
        'Tokens last 12 hours and can be refreshed for up to 7 days before a re-login is needed.',
    });
  }

  override getAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    return fetchAccountFromMcpTool(
      apiCredentials,
      MCP_ENDPOINT,
      'current_user',
      {},
      parseAccountFromCurrentUserResult
    );
  }
}

export const BUILDKITE_MCP = new BuildkiteMcp();
