/**
 * Airtable's remote MCP server (mcp.airtable.com), guarded by Airtable's own
 * OAuth 2.1 server with dynamic client registration. Endpoints and scopes come
 * from https://mcp.airtable.com/.well-known/oauth-protected-resource and
 * https://airtable.com/.well-known/oauth-authorization-server/oauth2/v1.
 */

import { RemoteMcpService } from './core/remoteMcp.js';

export const AIRTABLE_MCP = new RemoteMcpService({
  name: 'airtable-mcp',
  displayName: 'Airtable MCP',
  mcpEndpoint: 'https://mcp.airtable.com/mcp',
  oauth: {
    authorizationEndpoint: 'https://airtable.com/oauth2/v1/authorize',
    tokenEndpoint: 'https://airtable.com/oauth2/v1/token',
    registrationEndpoint: 'https://airtable.com/oauth2/v1/register',
  },
  scopes: [
    'data.records:read',
    'data.records:write',
    'schema.bases:read',
    'schema.bases:write',
    'data.recordComments:read',
    'data.recordComments:write',
    'workspacesAndBases:read',
  ],
  info:
    'https://airtable.com/developers/agents/mcp/getting-started (setup and tool overview). ' +
    'https://airtable.com/developers/agents/mcp/tools (tool catalog; no input schemas — discover them with a `tools/list` JSON-RPC call to the MCP endpoint). ' +
    'Available on all plans; tools respect base roles (owners/creators may change schema, editors only records) and only reach bases the user granted at login.',
});
