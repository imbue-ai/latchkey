/**
 * invideo MCP service: invideo's remote MCP server (AI video projects and
 * timelines), a Streamable HTTP endpoint behind OAuth 2.1 with dynamic client
 * registration. Endpoints come from the server's protected resource metadata
 * (https://mcp.invideo.io/.well-known/oauth-protected-resource/mcp) and the
 * authorization server metadata it points to at pro-api-auth.invideo.io.
 */

import { RemoteMcpService } from './core/remoteMcp.js';

export const INVIDEO_MCP = new RemoteMcpService({
  name: 'invideo-mcp',
  displayName: 'invideo MCP',
  mcpEndpoint: 'https://mcp.invideo.io/mcp',
  oauth: {
    authorizationEndpoint: 'https://invideo.io/oauth/authorize',
    tokenEndpoint: 'https://pro-api-auth.invideo.io/oauth/token',
    registrationEndpoint: 'https://pro-api-auth.invideo.io/oauth/register',
  },
  scopes: ['mcp.full_access'],
  info:
    'https://help.invideo.io/en/articles/11316042-invideo-model-context-protocol-server (end-user setup). ' +
    'https://mcp.invideo.io/mcp/agents.md (agent guide, usage over plain HTTP). ' +
    'Beta. No page lists the tools: discover them with a `tools/list` JSON-RPC call to the MCP endpoint, ' +
    'then call the `get_help` tool for how projects, timelines and media work. ' +
    'The legacy `/sse` endpoint is retired.',
});
