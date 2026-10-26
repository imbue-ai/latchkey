/**
 * Webflow MCP service: Webflow's remote MCP server (mcp.webflow.com) behind
 * OAuth 2.1 with dynamic client registration. The endpoints come from the
 * server's own RFC 9728 / RFC 8414 metadata at
 * https://mcp.webflow.com/.well-known/oauth-authorization-server.
 */

import { RemoteMcpService } from './core/remoteMcp.js';

export const WEBFLOW_MCP = new RemoteMcpService({
  name: 'webflow-mcp',
  displayName: 'Webflow MCP',
  mcpEndpoint: 'https://mcp.webflow.com/mcp',
  oauth: {
    authorizationEndpoint: 'https://mcp.webflow.com/oauth/authorize',
    tokenEndpoint: 'https://mcp.webflow.com/oauth/token',
    registrationEndpoint: 'https://mcp.webflow.com/oauth/register',
  },
  info:
    'https://developers.webflow.com/mcp/reference/how-it-works. ' +
    'https://developers.webflow.com/mcp/tools/data-tools (tool reference). ' +
    'Data API tools (sites, CMS, pages, custom code) work headless; ' +
    'Designer API tools require the MCP Bridge App to be open in the Webflow Designer. ' +
    'Each authorization is scoped to a single workspace.',
});
