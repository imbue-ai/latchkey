/**
 * Gamma MCP service: Gamma's remote MCP server (generate, edit, export and
 * browse gammas). Endpoints come from https://mcp.gamma.app/.well-known/oauth-protected-resource
 * and https://auth.gamma.app/.well-known/oauth-authorization-server, which also list the scopes.
 */

import { RemoteMcpService } from './core/remoteMcp.js';

export const GAMMA_MCP = new RemoteMcpService({
  name: 'gamma-mcp',
  displayName: 'Gamma MCP',
  mcpEndpoint: 'https://mcp.gamma.app/mcp',
  oauth: {
    authorizationEndpoint: 'https://auth.gamma.app/oauth/authorize',
    tokenEndpoint: 'https://auth.gamma.app/oauth/token',
    registrationEndpoint: 'https://auth.gamma.app/oauth/register',
  },
  scopes: ['generate', 'gamma:read'],
  info:
    'https://developers.gamma.app/mcp/mcp-tools-reference (tool names, parameters, errors). ' +
    'https://developers.gamma.app/mcp/gamma-mcp-server (setup). ' +
    'Generation, image, export and edit tools are asynchronous (poll the matching `get_*_status` tool) and consume Gamma credits.',
});
