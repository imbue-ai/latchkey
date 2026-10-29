/**
 * Linktree MCP service: Linktree's remote MCP server at mcp.linktr.ee, the
 * only official programmatic access to Linktree. The OAuth endpoints (Descope,
 * at ciam.linktr.ee) are copied from the authorization server metadata that
 * https://mcp.linktr.ee/.well-known/oauth-protected-resource points at.
 */

import { RemoteMcpService } from './core/remoteMcp.js';

export const LINKTREE_MCP = new RemoteMcpService({
  name: 'linktree-mcp',
  displayName: 'Linktree MCP',
  mcpEndpoint: 'https://mcp.linktr.ee/mcp',
  oauth: {
    authorizationEndpoint:
      'https://ciam.linktr.ee/oauth2/v1/apps/agentic/P32ACVpudk8MNftmpf1LR1pW5k8s/MS3C64tMj5Trl5KunDJVudGIMAeGB/authorize',
    tokenEndpoint:
      'https://ciam.linktr.ee/oauth2/v1/apps/agentic/P32ACVpudk8MNftmpf1LR1pW5k8s/MS3C64tMj5Trl5KunDJVudGIMAeGB/token',
    registrationEndpoint:
      'https://ciam.linktr.ee/v1/mgmt/mcp/client/P32ACVpudk8MNftmpf1LR1pW5k8s/MS3C64tMj5Trl5KunDJVudGIMAeGB/register',
  },
  // The one scope the server knows; it is what makes the token endpoint hand
  // out a refresh token. Tool access is not scoped.
  scopes: ['offline_access'],
  info:
    "Use Linktree's MCP server as a plain JSON-RPC API; Linktree has no public REST API. " +
    'https://mcp.linktr.ee/docs (official tool reference: 37 tools for profiles, links, collections, appearance, social icons, workspaces, analytics, with parameters and the error contract). ' +
    'https://mcp.linktr.ee/.well-known/mcp/tools.json (the same, machine-readable). ' +
    'Most tools target a profile via `username`/`profileUrl`; a user with several profiles gets a PROFILE_REQUIRED error until `set_active_profile` is called. ' +
    'Use `tools/list` for the live input schemas.',
});
