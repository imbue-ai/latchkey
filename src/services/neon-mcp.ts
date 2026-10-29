/**
 * Neon MCP service: Neon's hosted remote MCP server (Postgres projects,
 * branches, SQL, migrations). Endpoints come from the server's own RFC 8414
 * metadata at https://mcp.neon.tech/.well-known/oauth-authorization-server.
 */

import { RemoteMcpService } from './core/remoteMcp.js';

export const NEON_MCP = new RemoteMcpService({
  name: 'neon-mcp',
  displayName: 'Neon MCP',
  mcpEndpoint: 'https://mcp.neon.tech/mcp',
  oauth: {
    authorizationEndpoint: 'https://mcp.neon.tech/api/authorize',
    tokenEndpoint: 'https://mcp.neon.tech/api/token',
    registrationEndpoint: 'https://mcp.neon.tech/api/register',
  },
  scopes: ['read', 'write'],
  info:
    'https://neon.com/docs/ai/neon-mcp-server (setup, URL parameters such as ?readonly=true and ?category=, tool categories). ' +
    'https://mcp.neon.tech/api/list-tools (full tool list with input schemas, no auth needed). ' +
    'A Neon API key also works as the Bearer token. ' +
    'OAuth sessions default to the personal account; pass org_id/project_id in tool arguments for organization projects.',
});
