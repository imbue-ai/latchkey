/**
 * PayPal MCP service: PayPal's remote MCP server (invoices, orders,
 * subscriptions, transactions, disputes, ...). Endpoints are taken from
 * https://mcp.paypal.com/.well-known/oauth-authorization-server.
 */

import { RemoteMcpService } from './core/remoteMcp.js';

export const PAYPAL_MCP = new RemoteMcpService({
  name: 'paypal-mcp',
  displayName: 'PayPal MCP',
  mcpEndpoint: 'https://mcp.paypal.com/mcp',
  oauth: {
    authorizationEndpoint: 'https://mcp.paypal.com/authorize',
    tokenEndpoint: 'https://mcp.paypal.com/token',
    registrationEndpoint: 'https://mcp.paypal.com/register',
  },
  // Login is against production; sandbox tokens (same OAuth flow at
  // mcp.sandbox.paypal.com) can be stored by hand and are injected as well.
  additionalBaseApiUrls: ['https://mcp.sandbox.paypal.com/'],
  info:
    'https://developer.paypal.com/ai-tools/mcp-server (quickstart), ' +
    'https://developer.paypal.com/ai-tools/agent-tools/ (tool catalog). ' +
    'Login is against production (mcp.paypal.com); the sandbox server at ' +
    'https://mcp.sandbox.paypal.com/mcp needs separately stored credentials. ' +
    'Use `tools/list` at runtime for input schemas.',
});
