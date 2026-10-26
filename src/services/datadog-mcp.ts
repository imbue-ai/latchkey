/**
 * Datadog MCP server (https://docs.datadoghq.com/mcp_server/). Endpoints taken
 * from the live RFC 9728 / RFC 8414 metadata at mcp.datadoghq.com; login goes
 * through the default US1 site, the other sites run their own MCP hosts.
 */

import { RemoteMcpService } from './core/remoteMcp.js';

export const DATADOG_MCP = new RemoteMcpService({
  name: 'datadog-mcp',
  displayName: 'Datadog MCP',
  mcpEndpoint: 'https://mcp.datadoghq.com/v1/mcp',
  oauth: {
    authorizationEndpoint: 'https://app.datadoghq.com/oauth2/v1/authorize',
    tokenEndpoint: 'https://app.datadoghq.com/api/v2/oauth2/token',
    registrationEndpoint: 'https://app.datadoghq.com/api/v2/oauth2/register',
  },
  scopes: ['mcp_all'],
  additionalBaseApiUrls: [
    /^https:\/\/mcp\.(us3|us5|ap1|ap2|uk1)\.datadoghq\.com\//,
    'https://mcp.datadoghq.eu/',
  ],
  info:
    'https://docs.datadoghq.com/mcp_server/tools (tool reference by toolset). ' +
    'https://docs.datadoghq.com/mcp_server/setup (connection, toolsets, permissions). ' +
    'Only the `core` toolset is exposed by default; append `?toolsets=all` (or a comma-separated list) to the endpoint for more. ' +
    'MCP access must be enabled in the organization settings and the user needs the `mcp_read`/`mcp_write` permissions. ' +
    'Login uses the US1 site (mcp.datadoghq.com); other sites (US3, US5, EU, AP1, AP2, UK1) have their own mcp.<site> host and tokens, which can be stored by hand.',
});
