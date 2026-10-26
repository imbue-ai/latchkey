/**
 * Peloton MCP service: the remote MCP server at mcp.onepeloton.com that powers
 * Peloton's ChatGPT app (class search, class details, training plans and
 * scheduling classes onto the member's calendar). Endpoints are from
 * https://mcp.onepeloton.com/.well-known/oauth-authorization-server.
 */

import { RemoteMcpService } from './core/remoteMcp.js';

export const PELOTON_MCP = new RemoteMcpService({
  name: 'peloton-mcp',
  displayName: 'Peloton MCP',
  mcpEndpoint: 'https://mcp.onepeloton.com/mcp',
  oauth: {
    authorizationEndpoint: 'https://mcp.onepeloton.com/oauth/authorize',
    tokenEndpoint: 'https://mcp.onepeloton.com/oauth/token',
    registrationEndpoint: 'https://mcp.onepeloton.com/oauth/register',
  },
  // The metadata also lists a `claudeai` scope, which is Claude's own and left out.
  scopes: ['openid', 'peloton-api.members:default', 'offline_access'],
  // The metadata lists `authorization_code` as the only grant type.
  issuesRefreshTokens: false,
  info:
    'Peloton publishes no developer documentation for this server; discover the tools and their input schemas ' +
    'with a `tools/list` JSON-RPC call to the MCP endpoint. ' +
    'Tools seen: `search` (natural-language class search), `fetch` (class details by index), ' +
    "`create-training-plan` (weekly plan from class indices) and `schedule` (adds classes to the member's Peloton calendar). " +
    "`tools/list`, `search`, `fetch` and `create-training-plan` work without a token; `schedule` needs the user's OAuth token.",
});
