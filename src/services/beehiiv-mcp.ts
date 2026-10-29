/**
 * beehiiv MCP service: the remote MCP server for a beehiiv newsletter
 * publication (posts, subscribers, segments, automations, analytics). The
 * endpoints come from https://mcp.beehiiv.com/.well-known/oauth-authorization-server.
 */

import { RemoteMcpService } from './core/remoteMcp.js';

export const BEEHIIV_MCP = new RemoteMcpService({
  name: 'beehiiv-mcp',
  displayName: 'beehiiv MCP',
  mcpEndpoint: 'https://mcp.beehiiv.com/mcp',
  oauth: {
    authorizationEndpoint: 'https://mcp.beehiiv.com/authorize',
    tokenEndpoint: 'https://mcp.beehiiv.com/token',
    registrationEndpoint: 'https://mcp.beehiiv.com/register',
  },
  scopes: ['read', 'write', 'openid', 'email'],
  info:
    'https://www.beehiiv.com/support/article/39255979546263-getting-started-with-the-beehiiv-mcp. ' +
    'Free plans are read-only; write actions need a paid plan, and publishing or sending posts is not available via MCP. ' +
    'No official page lists the tools — discover them with a `tools/list` JSON-RPC call to the MCP endpoint.',
});
