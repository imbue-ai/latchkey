/**
 * Attio MCP service: Attio's hosted MCP server (CRM records, lists, notes,
 * tasks, meetings, e-mails) behind OAuth 2.1 with dynamic client registration.
 * Endpoints come from https://mcp.attio.com/.well-known/oauth-protected-resource
 * and https://app.attio.com/.well-known/oauth-authorization-server.
 */

import type { ApiCredentials } from '../apiCredentials/base.js';
import { tryParseJson } from '../apiCredentials/account.js';
import { fetchAccountFromMcpTool, RemoteMcpService } from './core/remoteMcp.js';

const MCP_ENDPOINT = 'https://mcp.attio.com/mcp';

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** The first string stored under any of `keys`, anywhere in a JSON value. */
function findStringByKey(value: unknown, keys: readonly string[]): string | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (keys.includes(key) && typeof nested === 'string') {
      return nested;
    }
    const found = findStringByKey(nested, keys);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/**
 * Extract the account from a `whoami` tool result, whose shape is not
 * documented: the user's e-mail (found by key, or anywhere in the text as a
 * last resort), combined with the workspace name when there is one, since an
 * Attio token is bound to a single workspace.
 */
function parseAccountFromWhoamiResult(toolResultText: string): string | null {
  const toolResult = tryParseJson(toolResultText);
  const email =
    findStringByKey(toolResult, ['email', 'email_address']) ??
    EMAIL_PATTERN.exec(toolResultText)?.[0] ??
    null;
  if (email === null) {
    return null;
  }
  const workspaceName = findStringByKey(toolResult, ['workspace_name', 'workspace_slug']);
  return workspaceName === null ? email : `${email}:${workspaceName}`;
}

export class AttioMcp extends RemoteMcpService {
  constructor() {
    super({
      name: 'attio-mcp',
      displayName: 'Attio MCP',
      mcpEndpoint: MCP_ENDPOINT,
      oauth: {
        authorizationEndpoint: 'https://app.attio.com/oidc/authorize',
        tokenEndpoint: 'https://app.attio.com/oidc/token',
        registrationEndpoint: 'https://app.attio.com/oauth/register',
      },
      scopes: ['openid', 'offline_access', 'mcp'],
      info:
        'https://docs.attio.com/mcp (tool catalog with per-tier rate limits). ' +
        'Acts as the logged-in Attio user with their permissions; `query-particle-sql` is not available on every billing plan. ' +
        'Tool input schemas are not documented — call `tools/list` on the MCP endpoint to discover them.',
    });
  }

  override getAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    return fetchAccountFromMcpTool(
      apiCredentials,
      MCP_ENDPOINT,
      'whoami',
      {},
      parseAccountFromWhoamiResult
    );
  }
}

export const ATTIO_MCP = new AttioMcp();
