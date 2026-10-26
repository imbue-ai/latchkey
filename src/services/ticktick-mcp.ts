/**
 * TickTick's official remote MCP server (tasks, lists, habits).
 *
 * Endpoints come from https://mcp.ticktick.com/.well-known/oauth-protected-resource
 * and https://ticktick.com/.well-known/oauth-authorization-server.
 */

import { RemoteMcpService } from './core/remoteMcp.js';

export const TICKTICK_MCP = new RemoteMcpService({
  name: 'ticktick-mcp',
  displayName: 'TickTick MCP',
  // The server lives at the bare origin; there is no `/mcp` path.
  mcpEndpoint: 'https://mcp.ticktick.com/',
  oauth: {
    authorizationEndpoint: 'https://ticktick.com/oauth/authorize',
    tokenEndpoint: 'https://api.ticktick.com/oauth/token',
    registrationEndpoint: 'https://api.ticktick.com/oauth/register',
  },
  scopes: ['tasks:read', 'tasks:write'],
  // The authorization server metadata lists authorization_code as the only
  // supported grant, so a login must not be refused for want of a refresh token.
  issuesRefreshTokens: false,
  info:
    'https://help.ticktick.com/articles/7438129581631995904 (setup guide; no tool catalog: discover tools with a `tools/list` JSON-RPC call to the MCP endpoint). ' +
    'A TickTick API token (Settings → Account & Security → API Token) also works as the bearer token.',
});
