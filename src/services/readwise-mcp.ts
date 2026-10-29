/**
 * Readwise MCP service: the remote MCP server for Readwise highlights and
 * Reader documents. Endpoints and scopes come from the server's RFC 9728
 * metadata at https://mcp2.readwise.io/.well-known/oauth-protected-resource/mcp
 * and the RFC 8414 metadata at https://readwise.io/.well-known/oauth-authorization-server/o.
 */

import { RemoteMcpService } from './core/remoteMcp.js';

export const READWISE_MCP = new RemoteMcpService({
  name: 'readwise-mcp',
  displayName: 'Readwise MCP',
  mcpEndpoint: 'https://mcp2.readwise.io/mcp',
  oauth: {
    authorizationEndpoint: 'https://readwise.io/o/authorize/',
    tokenEndpoint: 'https://readwise.io/o/token/',
    registrationEndpoint: 'https://readwise.io/o/register/',
  },
  scopes: ['openid', 'read', 'write'],
  info:
    'https://docs.readwise.io/tools/mcp (tool list for highlights and Reader documents), ' +
    'https://readwise.io/mcp (setup). ' +
    'Tool names and input schemas are not documented — discover them with a `tools/list` JSON-RPC call to the MCP endpoint.',
});
