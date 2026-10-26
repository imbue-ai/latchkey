/**
 * ClickUp's official remote MCP server (public beta, all plans).
 *
 * Endpoints come from https://mcp.clickup.com/.well-known/oauth-protected-resource/mcp
 * and https://mcp.clickup.com/.well-known/oauth-authorization-server.
 */

import { RemoteMcpService } from './core/remoteMcp.js';

export const CLICKUP_MCP = new RemoteMcpService({
  name: 'clickup-mcp',
  displayName: 'ClickUp MCP',
  mcpEndpoint: 'https://mcp.clickup.com/mcp',
  oauth: {
    authorizationEndpoint: 'https://mcp.clickup.com/oauth/authorize',
    tokenEndpoint: 'https://mcp.clickup.com/oauth/token',
    registrationEndpoint: 'https://mcp.clickup.com/oauth/register',
  },
  scopes: ['read', 'write'],
  // The authorization server only supports the authorization_code grant and
  // strips refresh_token from registration requests.
  issuesRefreshTokens: false,
  info:
    'https://developer.clickup.com/docs/mcp-tools (tool catalog, no input schemas: discover them with a `tools/list` JSON-RPC call to the MCP endpoint). ' +
    'https://help.clickup.com/hc/en-us/articles/33335772678423-What-is-ClickUp-MCP (rate limits per plan: a rolling 24-hour workspace-wide cap without the Everything AI add-on). ' +
    'OAuth is the only supported auth; API keys do not work here.',
});
