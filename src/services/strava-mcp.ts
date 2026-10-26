// Strava's remote MCP server (https://mcp.strava.com/mcp). The OAuth endpoints
// come from https://www.strava.com/.well-known/oauth-authorization-server/mcp-issuer,
// the authorization server named by the MCP host's protected resource metadata.
// That metadata advertises no PKCE methods; the base sends S256 regardless, as MCP clients must.

import { RemoteMcpService } from './core/remoteMcp.js';

export const STRAVA_MCP = new RemoteMcpService({
  name: 'strava-mcp',
  displayName: 'Strava MCP',
  mcpEndpoint: 'https://mcp.strava.com/mcp',
  oauth: {
    authorizationEndpoint: 'https://www.strava.com/oauth/mcp/authorize',
    tokenEndpoint: 'https://www.strava.com/oauth/mcp/token',
    registrationEndpoint: 'https://www.strava.com/oauth/mcp/register_client',
  },
  scopes: ['read', 'read_all', 'activity:read', 'activity:read_all', 'profile:read_all'],
  info:
    'https://support.strava.com/en-us/articles/15401531-strava-mcp-connector. ' +
    'Subscribers only (trials excluded); read-only access to activities, fitness trends, readiness, goals and gear. ' +
    'Strava currently registers Claude clients only: dynamic registration of other clients is refused, so ' +
    '`latchkey auth browser` fails at that step unless a client id has been prepared with `latchkey auth prepare`. ' +
    'No tool catalog is published; discover tools with a `tools/list` JSON-RPC call.',
});
