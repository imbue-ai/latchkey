/**
 * Intercom's remote MCP server (mcp.intercom.com), guarded by its own OAuth 2.1
 * server with dynamic client registration. Endpoints and scopes come from
 * https://mcp.intercom.com/.well-known/oauth-authorization-server; the EU host
 * is listed in https://developers.intercom.com/docs/guides/mcp.
 */

import { RemoteMcpService } from './core/remoteMcp.js';

export const INTERCOM_MCP = new RemoteMcpService({
  name: 'intercom-mcp',
  displayName: 'Intercom MCP',
  mcpEndpoint: 'https://mcp.intercom.com/mcp',
  oauth: {
    authorizationEndpoint: 'https://mcp.intercom.com/authorize',
    tokenEndpoint: 'https://mcp.intercom.com/token',
    registrationEndpoint: 'https://mcp.intercom.com/register',
  },
  scopes: ['mcp', 'operator'],
  // EU-hosted workspaces have their own deployment with the same tools; login
  // always goes through the US host. AU-hosted workspaces are not supported.
  additionalBaseApiUrls: ['https://mcp.eu.intercom.com/'],
  info:
    'https://developers.intercom.com/docs/guides/mcp (tool catalog, query DSL and pagination notes). ' +
    'US workspaces use https://mcp.intercom.com/mcp, EU workspaces https://mcp.eu.intercom.com/mcp; AU workspaces are not supported. ' +
    'Tool input schemas are not published — discover them with a `tools/list` JSON-RPC call to the MCP endpoint.',
});
