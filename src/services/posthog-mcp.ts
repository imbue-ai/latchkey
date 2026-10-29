/**
 * PostHog MCP service: PostHog's remote MCP server (insights, feature flags,
 * experiments, error tracking, SQL) behind OAuth 2.1 with dynamic client
 * registration. Endpoints from https://mcp.posthog.com/.well-known/oauth-protected-resource
 * and https://oauth.posthog.com/.well-known/oauth-authorization-server.
 */

import { RemoteMcpService } from './core/remoteMcp.js';

export const POSTHOG_MCP = new RemoteMcpService({
  name: 'posthog-mcp',
  displayName: 'PostHog MCP',
  mcpEndpoint: 'https://mcp.posthog.com/mcp',
  oauth: {
    authorizationEndpoint: 'https://oauth.posthog.com/oauth/authorize/',
    tokenEndpoint: 'https://oauth.posthog.com/oauth/token/',
    registrationEndpoint: 'https://oauth.posthog.com/oauth/register/',
  },
  // EU cloud projects are served from their own host; login goes through the
  // US host, whose authorization server routes by account.
  additionalBaseApiUrls: ['https://mcp-eu.posthog.com/'],
  info:
    'https://posthog.com/docs/model-context-protocol and ' +
    'https://posthog.com/docs/model-context-protocol/faq (read-only mode via `?readonly=1` or the ' +
    '`x-posthog-read-only` header; tool filtering via `?features=...` and `?tools=...`). ' +
    'A personal API key (MCP Server preset) also works as the bearer token. ' +
    'EU cloud projects use https://mcp-eu.posthog.com/mcp.',
});
