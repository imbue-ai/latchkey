/**
 * Any.do MCP service: the remote MCP server at mcp.any.do (tasks, lists,
 * reminders, team workspaces). The OAuth endpoints and scopes come from the
 * server's own RFC 9728 / RFC 8414 metadata under
 * https://mcp.any.do/.well-known/.
 */

import { RemoteMcpService } from './core/remoteMcp.js';

export const ANYDO_MCP = new RemoteMcpService({
  name: 'anydo-mcp',
  displayName: 'Any.do MCP',
  mcpEndpoint: 'https://mcp.any.do/mcp',
  oauth: {
    authorizationEndpoint: 'https://mcp.any.do/authorize',
    tokenEndpoint: 'https://mcp.any.do/token',
    registrationEndpoint: 'https://mcp.any.do/register',
  },
  scopes: ['access_anydo_data', 'update_anydo_data'],
  info:
    'https://www.any.do/blog/ai-to-do-list-any-do-mcp/ (announcement: capabilities and client setup; no tool catalog). ' +
    'Read/write access to tasks, lists, reminders and team workspaces. ' +
    'Tool names and input schemas are not documented — discover them with a `tools/list` JSON-RPC call to the MCP endpoint.',
});
