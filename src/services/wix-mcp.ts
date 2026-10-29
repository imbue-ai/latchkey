/**
 * Wix MCP service: the remote MCP server at mcp.wix.com, a gateway to the Wix
 * REST APIs and documentation behind one OAuth login. Endpoints come from the
 * server's RFC 9728 / RFC 8414 metadata at mcp.wix.com/.well-known/.
 */

import { RemoteMcpService } from './core/remoteMcp.js';

export const WIX_MCP = new RemoteMcpService({
  name: 'wix-mcp',
  displayName: 'Wix MCP',
  mcpEndpoint: 'https://mcp.wix.com/mcp',
  oauth: {
    authorizationEndpoint: 'https://mcp.wix.com/authorize',
    tokenEndpoint: 'https://mcp.wix.com/token',
    registrationEndpoint: 'https://mcp.wix.com/register',
  },
  scopes: ['offline_access'],
  info:
    'https://dev.wix.com/docs/sdk/articles/use-the-wix-mcp/about-the-wix-mcp.md (tool catalog: ' +
    'documentation search, ListWixSites, GetSiteContext, CallWixSiteAPI, ExecuteWixAPI, ManageWixSite). ' +
    'https://dev.wix.com/docs/sdk/articles/use-the-wix-mcp/mcp-sample-prompts.md. ' +
    'Tool input schemas are only available at runtime via `tools/list`; site-scoped tools need a siteId.',
});
