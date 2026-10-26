/**
 * Atlassian MCP service: the remote MCP server for Jira, Confluence, JSM,
 * Bitbucket, Compass and the rest of Atlassian Cloud. Endpoints come from the
 * server's live metadata (`/.well-known/oauth-protected-resource/v2/mcp` and
 * the `auth.atlassian.com` authorization server it names).
 */

import type { ApiCredentials } from '../apiCredentials/base.js';
import { tryParseJson } from '../apiCredentials/account.js';
import { fetchAccountFromMcpTool, RemoteMcpService } from './core/remoteMcp.js';

const MCP_ENDPOINT = 'https://mcp.atlassian.com/v2/mcp';

const SCOPES = [
  'read:me',
  'read:account',
  'offline_access',
  'email',
  'read:jira:agent-interface',
  'write:jira:agent-interface',
  'search:jira:agent-interface',
  'delete:jira:agent-interface',
  'manage:jira:agent-interface',
  'read:confluence:agent-interface',
  'write:confluence:agent-interface',
  'search:confluence:agent-interface',
  'search:rovo:agent-interface',
  'search:code:agent-interface',
  'read:jsm:agent-interface',
  'write:jsm:agent-interface',
  'read:all:twg',
  'write:all:twg',
  'read:goals:agent-interface',
  'write:goals:agent-interface',
  'read:projects:agent-interface',
  'write:projects:agent-interface',
  'read:bitbucket:agent-interface',
  'write:bitbucket:agent-interface',
  'read:loom:agent-interface',
  'write:loom:agent-interface',
  'read:talent:agent-interface',
  'write:talent:agent-interface',
  'read:jira-align:agent-interface',
  'write:jira-align:agent-interface',
  'read:teams:agent-interface',
  'write:teams:agent-interface',
  'read:artifacts:agent-interface',
  'write:artifacts:agent-interface',
  'read:capacity-planning:agent-interface',
  'write:capacity-planning:agent-interface',
  'read:focus:agent-interface',
  'write:focus:agent-interface',
  'read:assets:agent-interface',
  'write:assets:agent-interface',
] as const;

function parseAccountFromUserInfoResult(toolResultText: string): string | null {
  const userInfo = tryParseJson(toolResultText) as {
    email?: string;
    account_id?: string;
    accountId?: string;
  } | null;
  return userInfo?.email ?? userInfo?.account_id ?? userInfo?.accountId ?? null;
}

export class AtlassianMcp extends RemoteMcpService {
  constructor() {
    super({
      name: 'atlassian-mcp',
      displayName: 'Atlassian MCP',
      mcpEndpoint: MCP_ENDPOINT,
      oauth: {
        authorizationEndpoint: 'https://auth.atlassian.com/authorize',
        tokenEndpoint: 'https://auth.atlassian.com/oauth/token',
        registrationEndpoint:
          'https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3/dcr/register',
      },
      scopes: SCOPES,
      info:
        'https://support.atlassian.com/atlassian-ai-gateway/docs/supported-tools/ (tool catalog). ' +
        'https://support.atlassian.com/atlassian-ai-gateway/docs/get-started-with-the-atlassian-remote-mcp-server/. ' +
        'Every tool needs a `cloudId`: call `getAccessibleAtlassianResources` first. ' +
        'By default `tools/list` returns only a few primary tools plus `discover`/`execute*`; ' +
        'POST to `https://mcp.atlassian.com/v2/mcp?tools=all` for the flat, paginated list of all tools.',
    });
  }

  // The `atlassianUserInfo` tool returns the authenticated user's account.
  override getAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    return fetchAccountFromMcpTool(
      apiCredentials,
      MCP_ENDPOINT,
      'atlassianUserInfo',
      {},
      parseAccountFromUserInfoResult
    );
  }
}

export const ATLASSIAN_MCP = new AtlassianMcp();
