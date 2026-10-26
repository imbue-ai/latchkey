/**
 * Substack MCP service: Substack's remote MCP server, its only official API.
 *
 * Endpoints come from https://mcp.substack.com/.well-known/oauth-protected-resource
 * (authorization server https://substack.com) and
 * https://substack.com/.well-known/oauth-authorization-server.
 */

import { RemoteMcpService } from './core/remoteMcp.js';

export const SUBSTACK_MCP = new RemoteMcpService({
  name: 'substack-mcp',
  displayName: 'Substack MCP',
  mcpEndpoint: 'https://mcp.substack.com/api/v1/mcp',
  oauth: {
    authorizationEndpoint: 'https://substack.com/oauth/auth',
    tokenEndpoint: 'https://mcp.substack.com/oauth/token',
    registrationEndpoint: 'https://mcp.substack.com/oauth/register',
  },
  // Both the protected resource metadata and the 401 challenge name these.
  scopes: ['mcp:read', 'mcp.user.read'],
  info:
    'https://support.substack.com/hc/en-us/articles/50834026608916 (setup guide; no tool catalog). ' +
    'Read-only publication analytics (subscribers, post performance, revenue, retention); no publishing. ' +
    'Requires an Admin on a Bestseller publication. ' +
    'Discover the tools with a `tools/list` JSON-RPC call.',
});
