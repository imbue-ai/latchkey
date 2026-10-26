/**
 * Otter.ai MCP service: Otter's remote MCP server at mcp.otter.ai, the only
 * consumer-grade API access to Otter (the REST API is Enterprise-only).
 * Endpoints come from https://mcp.otter.ai/.well-known/oauth-protected-resource
 * and https://otter.ai/.well-known/oauth-authorization-server.
 */

import { RemoteMcpService } from './core/remoteMcp.js';

export const OTTER_MCP = new RemoteMcpService({
  name: 'otter-mcp',
  displayName: 'Otter.ai MCP',
  mcpEndpoint: 'https://mcp.otter.ai/mcp',
  oauth: {
    authorizationEndpoint: 'https://otter.ai/oauth2/authorize',
    tokenEndpoint: 'https://otter.ai/oauth/token',
    registrationEndpoint: 'https://otter.ai/oauth/register',
  },
  scopes: ['profile:read', 'conversations:read'],
  info:
    'Use Otter.ai\'s MCP endpoint as a "normal" JSON-RPC API. ' +
    'https://help.otter.ai/hc/en-us/articles/35287607569687-Otter-MCP-Server (official setup guide; no tool reference). ' +
    'The server is read-only with three tools (search meetings, get a transcript/summary, current user); ' +
    'discover their names and input schemas with a `tools/list` JSON-RPC call to the MCP endpoint.',
});
