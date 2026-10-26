/**
 * Mixpanel MCP service: Mixpanel's remote MCP server as a JSON-RPC-over-HTTP
 * API. Endpoints and scopes come from the server's live metadata
 * (`https://mcp.mixpanel.com/.well-known/oauth-protected-resource/mcp` names
 * `https://auth.mixpanel.com` as the authorization server).
 */

import { RemoteMcpService } from './core/remoteMcp.js';

export const MIXPANEL_MCP = new RemoteMcpService({
  name: 'mixpanel-mcp',
  displayName: 'Mixpanel MCP',
  mcpEndpoint: 'https://mcp.mixpanel.com/mcp',
  oauth: {
    authorizationEndpoint: 'https://mixpanel.com/oauth/authorize',
    tokenEndpoint: 'https://mixpanel.com/oauth/token/',
    registrationEndpoint: 'https://mixpanel.com/oauth/mcp/register/',
  },
  scopes: [
    'projects',
    'analysis',
    'events',
    'insights',
    'segmentation',
    'retention',
    'data:read',
    'funnels',
    'flows',
    'data_definitions',
    'alerts',
    'annotations',
    'bookmarks',
    'business_context',
    'cohorts',
    'context',
    'custom_alerts',
    'custom_events',
    'custom_properties',
    'dashboard_reports',
    'experiments',
    'feature_flags',
    'metrics',
    'user_details',
  ],
  additionalBaseApiUrls: ['https://mcp-eu.mixpanel.com/', 'https://mcp-in.mixpanel.com/'],
  info:
    'Use Mixpanel\'s MCP endpoint as a "normal" JSON API. ' +
    'https://docs.mixpanel.com/docs/features/mcp (tool catalog, service accounts). ' +
    'Login uses the US host (mcp.mixpanel.com); EU and India projects live on mcp-eu.mixpanel.com / mcp-in.mixpanel.com, ' +
    'so store a token for those by hand. Service accounts (Basic auth, beta) are the headless alternative.',
});
