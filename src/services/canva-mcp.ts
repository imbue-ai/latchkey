/**
 * Canva MCP service: Canva's hosted remote MCP server (design creation and
 * editing, assets, folders, comments, exports, brand kits and templates).
 * Endpoints come from https://mcp.canva.com/.well-known/oauth-protected-resource/mcp
 * and https://mcp.canva.com/.well-known/oauth-authorization-server.
 */

import { RemoteMcpService } from './core/remoteMcp.js';

export const CANVA_MCP = new RemoteMcpService({
  name: 'canva-mcp',
  displayName: 'Canva MCP',
  mcpEndpoint: 'https://mcp.canva.com/mcp',
  oauth: {
    authorizationEndpoint: 'https://mcp.canva.com/authorize',
    tokenEndpoint: 'https://mcp.canva.com/token',
    registrationEndpoint: 'https://mcp.canva.com/register',
  },
  scopes: [
    'profile:read',
    'design:meta:read',
    'design:content:write',
    'design:content:read',
    'folder:read',
    'folder:write',
    'brandtemplate:content:read',
    'brandtemplate:meta:read',
    'brandtemplate:content:write',
    'comment:write',
    'comment:read',
    'asset:read',
    'asset:write',
    'brandkit:read',
    'help:answers:read',
    'help:answers:write',
  ],
  info:
    'https://www.canva.dev/docs/apps/mcp/ (overview). ' +
    'https://www.canva.dev/docs/apps/mcp/tools/ (tool catalog with rate limits and plan availability). ' +
    'Autofill, brand kits, brand templates and resize-design need Canva Pro or above; ' +
    'a user only sees the designs and assets they can access in Canva.',
});
