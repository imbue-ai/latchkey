/**
 * Cloudflare's remote MCP servers, one latchkey service per host.
 *
 * Cloudflare runs a separate MCP server per product area, each on its own
 * `<slug>.mcp.cloudflare.com` host that doubles as its own OAuth authorization
 * server: tokens are audience-bound to the host, so a login to one server is
 * of no use to another and each host gets its own service and credential set.
 * The domain-specific hosts all publish the same endpoint layout
 * (`/oauth/authorize`, `/token`, `/register`, no scopes); the umbrella
 * Cloudflare API server on the bare `mcp.cloudflare.com` host differs and is
 * defined on its own. Hosts that need no login (docs, blog, demo-day) have no
 * service.
 */

import { RemoteMcpService } from './core/remoteMcp.js';

const MCP_SERVER_REPOSITORY_URL = 'https://github.com/cloudflare/mcp-server-cloudflare';
const API_MCP_ENDPOINT = 'https://mcp.cloudflare.com/mcp';

interface CloudflareMcpHostDefinition {
  /** The subdomain of `mcp.cloudflare.com` the server lives on. */
  readonly slug: string;
  readonly label: string;
  /** The server's folder under `apps/` in the GitHub repository; its README lists the tools. */
  readonly repositoryApp: string;
  readonly summary: string;
  /** Deprecated upstream in favour of the Cloudflare API MCP server, but still live. */
  readonly deprecated?: boolean;
}

function buildCloudflareMcpService(definition: CloudflareMcpHostDefinition): RemoteMcpService {
  const host = `https://${definition.slug}.mcp.cloudflare.com`;
  const deprecationNote = definition.deprecated
    ? ' Deprecated by Cloudflare in favour of cloudflare-api-mcp, but still running.'
    : '';
  return new RemoteMcpService({
    name: `cloudflare-${definition.slug}-mcp`,
    displayName: `Cloudflare ${definition.label} MCP`,
    mcpEndpoint: `${host}/mcp`,
    oauth: {
      authorizationEndpoint: `${host}/oauth/authorize`,
      tokenEndpoint: `${host}/token`,
      registrationEndpoint: `${host}/register`,
    },
    info:
      `${MCP_SERVER_REPOSITORY_URL}/tree/main/apps/${definition.repositoryApp} (README lists the tools). ` +
      `${definition.summary}${deprecationNote} ` +
      'Tool input schemas: call `tools/list`.',
  });
}

export const CLOUDFLARE_CONTAINERS_MCP = buildCloudflareMcpService({
  slug: 'containers',
  label: 'Containers',
  repositoryApp: 'sandbox-container',
  summary: 'Ephemeral sandbox container to run code (Node, Python, ...) and manage its files.',
});

export const CLOUDFLARE_BROWSER_MCP = buildCloudflareMcpService({
  slug: 'browser',
  label: 'Browser',
  repositoryApp: 'browser-rendering',
  summary: 'Browser Run: fetch web pages, convert them to markdown, take screenshots.',
});

export const CLOUDFLARE_DEX_MCP = buildCloudflareMcpService({
  slug: 'dex',
  label: 'DEX',
  repositoryApp: 'dex-analysis',
  summary:
    'Digital Experience Monitoring: device, network and application performance across a Zero Trust organization.',
});

export const CLOUDFLARE_CASB_MCP = buildCloudflareMcpService({
  slug: 'casb',
  label: 'CASB',
  repositoryApp: 'cloudflare-one-casb',
  summary:
    'Cloudflare One CASB integrations, assets and asset categories (SaaS misconfigurations).',
});

export const CLOUDFLARE_AI_GATEWAY_MCP = buildCloudflareMcpService({
  slug: 'ai-gateway',
  label: 'AI Gateway',
  repositoryApp: 'ai-gateway',
  summary: 'AI Gateway logs: list gateways, search logs, inspect prompts and responses.',
  deprecated: true,
});

export const CLOUDFLARE_AUDITLOGS_MCP = buildCloudflareMcpService({
  slug: 'auditlogs',
  label: 'Audit Logs',
  repositoryApp: 'auditlogs',
  summary: 'Query account audit logs and generate reports.',
  deprecated: true,
});

export const CLOUDFLARE_AUTORAG_MCP = buildCloudflareMcpService({
  slug: 'autorag',
  label: 'AutoRAG',
  repositoryApp: 'autorag',
  summary: 'List, search and query the account AutoRAG (AI Search) instances.',
  deprecated: true,
});

export const CLOUDFLARE_DNS_ANALYTICS_MCP = buildCloudflareMcpService({
  slug: 'dns-analytics',
  label: 'DNS Analytics',
  repositoryApp: 'dns-analytics',
  summary: 'DNS analytics and settings of the account zones for performance debugging.',
  deprecated: true,
});

export const CLOUDFLARE_GRAPHQL_MCP = buildCloudflareMcpService({
  slug: 'graphql',
  label: 'GraphQL',
  repositoryApp: 'graphql',
  summary: 'Cloudflare GraphQL Analytics API: schema introspection and queries.',
  deprecated: true,
});

export const CLOUDFLARE_LOGS_MCP = buildCloudflareMcpService({
  slug: 'logs',
  label: 'Logpush',
  repositoryApp: 'logpush',
  summary: 'Logpush job health summaries.',
  deprecated: true,
});

export const CLOUDFLARE_OBSERVABILITY_MCP = buildCloudflareMcpService({
  slug: 'observability',
  label: 'Observability',
  repositoryApp: 'workers-observability',
  summary: 'Workers logs and analytics for debugging applications.',
  deprecated: true,
});

export const CLOUDFLARE_RADAR_MCP = buildCloudflareMcpService({
  slug: 'radar',
  label: 'Radar',
  repositoryApp: 'radar',
  summary: 'Cloudflare Radar internet insights: traffic, attacks, DNS, HTTP, URL scanner.',
  deprecated: true,
});

export const CLOUDFLARE_BINDINGS_MCP = buildCloudflareMcpService({
  slug: 'bindings',
  label: 'Workers Bindings',
  repositoryApp: 'workers-bindings',
  summary: 'Workers and their storage, AI and compute bindings: KV, R2, D1, Hyperdrive, ...',
  deprecated: true,
});

export const CLOUDFLARE_BUILDS_MCP = buildCloudflareMcpService({
  slug: 'builds',
  label: 'Workers Builds',
  repositoryApp: 'workers-builds',
  summary: 'Workers Builds: list builds, inspect build logs.',
  deprecated: true,
});

/**
 * The recommended umbrella server covering the whole Cloudflare API through
 * code execution (tools `search`, `execute`, `docs`, `whoami`). Unlike the
 * domain-specific hosts it authorizes at `/authorize` and uses scopes: the
 * ones its 401 challenge names, plus `offline_access` for a refresh token.
 * Calls that need more scopes fail with `insufficient_scope`, naming the scope.
 */
export const CLOUDFLARE_API_MCP = new RemoteMcpService({
  name: 'cloudflare-api-mcp',
  displayName: 'Cloudflare API MCP',
  mcpEndpoint: API_MCP_ENDPOINT,
  oauth: {
    authorizationEndpoint: 'https://mcp.cloudflare.com/authorize',
    tokenEndpoint: 'https://mcp.cloudflare.com/token',
    registrationEndpoint: 'https://mcp.cloudflare.com/register',
  },
  scopes: ['offline_access', 'user:read', 'account:read'],
  info:
    'https://github.com/cloudflare/mcp (README lists the tools). ' +
    'The whole Cloudflare API via code mode: `search` the OpenAPI spec, `execute` JavaScript calling `cloudflare.request()`, `docs`, `whoami`. ' +
    'Pick the needed permissions on the consent screen; a call lacking a scope fails with `insufficient_scope` naming it, so log in again then.',
});

export const CLOUDFLARE_MCP_SERVICES: readonly RemoteMcpService[] = [
  CLOUDFLARE_API_MCP,
  CLOUDFLARE_CONTAINERS_MCP,
  CLOUDFLARE_BROWSER_MCP,
  CLOUDFLARE_DEX_MCP,
  CLOUDFLARE_CASB_MCP,
  CLOUDFLARE_AI_GATEWAY_MCP,
  CLOUDFLARE_AUDITLOGS_MCP,
  CLOUDFLARE_AUTORAG_MCP,
  CLOUDFLARE_DNS_ANALYTICS_MCP,
  CLOUDFLARE_GRAPHQL_MCP,
  CLOUDFLARE_LOGS_MCP,
  CLOUDFLARE_OBSERVABILITY_MCP,
  CLOUDFLARE_RADAR_MCP,
  CLOUDFLARE_BINDINGS_MCP,
  CLOUDFLARE_BUILDS_MCP,
];
