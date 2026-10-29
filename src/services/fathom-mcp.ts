/**
 * Fathom (meeting notetaker, fathom.video / fathom.ai) remote MCP server.
 *
 * Endpoints come from https://api.fathom.ai/.well-known/oauth-authorization-server;
 * the same server is also reachable at https://fathom.video/mcp.
 */

import { RemoteMcpService } from './core/remoteMcp.js';

export const FATHOM_MCP = new RemoteMcpService({
  name: 'fathom-mcp',
  displayName: 'Fathom MCP',
  mcpEndpoint: 'https://api.fathom.ai/mcp',
  oauth: {
    authorizationEndpoint: 'https://fathom.video/mcp/oauth/authorize',
    tokenEndpoint: 'https://api.fathom.ai/mcp/oauth/token',
    registrationEndpoint: 'https://api.fathom.ai/mcp/oauth/register',
  },
  scopes: ['mcp'],
  additionalBaseApiUrls: ['https://fathom.video/'],
  info:
    'https://developers.fathom.ai/mcp-docs (client setup only; no page lists the tools). ' +
    'Discover tools with a `tools/list` JSON-RPC call to the MCP endpoint. ' +
    'Covers meetings, transcripts, summaries and action items. ' +
    'Available on all Fathom plans, including free.',
});
