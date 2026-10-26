/**
 * Evernote's remote MCP server (mcp.evernote.com), guarded by Evernote's
 * accounts OAuth 2.1 server with dynamic client registration. Endpoints and
 * scopes come from https://mcp.evernote.com/.well-known/oauth-protected-resource
 * and https://accounts.evernote.com/.well-known/oauth-authorization-server.
 */

import { RemoteMcpService } from './core/remoteMcp.js';

export const EVERNOTE_MCP = new RemoteMcpService({
  name: 'evernote-mcp',
  displayName: 'Evernote MCP',
  mcpEndpoint: 'https://mcp.evernote.com/mcp',
  oauth: {
    authorizationEndpoint: 'https://accounts.evernote.com/auth/authorize',
    tokenEndpoint: 'https://accounts.evernote.com/auth/token',
    registrationEndpoint: 'https://accounts.evernote.com/auth/register',
  },
  scopes: ['read', 'create', 'write', 'delete'],
  info:
    'https://help.evernote.com/hc/en-us/articles/51596325640339-Evernote-MCP-Model-Context-Protocol (overview only: reading and creating notes). ' +
    'No official tool catalog exists — discover tools with a `tools/list` JSON-RPC call to the MCP endpoint. ' +
    'Paid Evernote plans only. Evernote no longer issues classic developer API keys, so this is the way in for new integrations.',
});
