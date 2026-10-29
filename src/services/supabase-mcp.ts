/**
 * Supabase MCP service: Supabase's remote MCP server at mcp.supabase.com,
 * fronted by the Supabase platform OAuth server at api.supabase.com. The
 * endpoints and scopes come from the server's RFC 9728 protected resource
 * metadata and the authorization server's RFC 8414 metadata.
 */

import { RemoteMcpService } from './core/remoteMcp.js';

export const SUPABASE_MCP = new RemoteMcpService({
  name: 'supabase-mcp',
  displayName: 'Supabase MCP',
  mcpEndpoint: 'https://mcp.supabase.com/mcp',
  oauth: {
    authorizationEndpoint: 'https://api.supabase.com/v1/oauth/authorize',
    tokenEndpoint: 'https://api.supabase.com/v1/oauth/token',
    registrationEndpoint: 'https://api.supabase.com/platform/oauth/apps/register',
  },
  scopes: [
    'organizations:read',
    'projects:read',
    'projects:write',
    'database:write',
    'database:read',
    'analytics:read',
    'secrets:read',
    'edge_functions:read',
    'edge_functions:write',
    'environment:read',
    'environment:write',
    'storage:read',
    'storage:write',
  ],
  info:
    'https://supabase.com/docs/guides/ai-tools/mcp (feature groups and tools). ' +
    'Scope the server with query parameters on the MCP URL: ' +
    '`?project_ref=<ref>&read_only=true&features=database,docs,...`. ' +
    'The OAuth consent picks an organization; the token covers all of its projects.',
});
