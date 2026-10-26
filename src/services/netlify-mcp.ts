/**
 * Netlify MCP service: Netlify's remote MCP server at netlify-mcp.netlify.app
 * (also served as mcp.netlify.com), which is its own OAuth 2.1 authorization
 * server. Endpoints and scopes come from the live RFC 9728 / RFC 8414 metadata.
 */

import type { ApiCredentials } from '../apiCredentials/base.js';
import { tryParseJson } from '../apiCredentials/account.js';
import { fetchAccountFromMcpTool, RemoteMcpService } from './core/remoteMcp.js';

const MCP_ENDPOINT = 'https://netlify-mcp.netlify.app/mcp';

/**
 * Extract the account from a `netlify-user-get-user` tool result, which relays
 * `GET /api/v1/user`. The server stringifies the already serialized API body,
 * so the text is usually a JSON string wrapping the JSON object.
 */
function parseAccountFromGetUserResult(toolResultText: string): string | null {
  const parsedOnce = tryParseJson(toolResultText);
  const user = (typeof parsedOnce === 'string' ? tryParseJson(parsedOnce) : parsedOnce) as {
    email?: string;
    full_name?: string;
    id?: string;
  } | null;
  return user?.email ?? user?.full_name ?? user?.id ?? null;
}

export class NetlifyMcp extends RemoteMcpService {
  constructor() {
    super({
      name: 'netlify-mcp',
      displayName: 'Netlify MCP',
      mcpEndpoint: MCP_ENDPOINT,
      oauth: {
        authorizationEndpoint: 'https://netlify-mcp.netlify.app/oauth-server/auth',
        tokenEndpoint: 'https://netlify-mcp.netlify.app/oauth-server/token',
        registrationEndpoint: 'https://netlify-mcp.netlify.app/oauth-server/reg',
      },
      // The metadata also lists a `claudeai` scope, which is Claude's own and left out.
      scopes: ['offline_access', 'read', 'write'],
      additionalBaseApiUrls: ['https://mcp.netlify.com/'],
      info:
        'https://docs.netlify.com/build/build-with-ai/agent-setup-guides/agent-setup-overview.md (setup only; no official tool catalog). ' +
        'https://github.com/netlify/netlify-mcp (server source; `src/tools/` defines the tools). ' +
        'By default operations are grouped into per-domain selector tools (`netlify-<domain>-services-reader|updater`, argument `{selectSchema: {operation, params}}`); ' +
        'append `?verbose=true` to the endpoint for one tool per operation. Discover either surface with `tools/list`. ' +
        'Also reachable at https://mcp.netlify.com/mcp.',
    });
  }

  // The granular surface (`?verbose=true`) exposes the user profile as a
  // zero-argument tool; the default selector surface would need the operation
  // wrapped in `selectSchema`.
  override getAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    return fetchAccountFromMcpTool(
      apiCredentials,
      `${MCP_ENDPOINT}?verbose=true`,
      'netlify-user-get-user',
      {},
      parseAccountFromGetUserResult
    );
  }
}

export const NETLIFY_MCP = new NetlifyMcp();
