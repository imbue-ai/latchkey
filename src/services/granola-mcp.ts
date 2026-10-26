/**
 * Granola MCP service: the remote MCP server for Granola meeting notes.
 *
 * Endpoints are from https://mcp.granola.ai/.well-known/oauth-protected-resource
 * and https://mcp-auth.granola.ai/.well-known/oauth-authorization-server.
 */

import type { ApiCredentials } from '../apiCredentials/base.js';
import { tryParseJson } from '../apiCredentials/account.js';
import { fetchAccountFromMcpTool, RemoteMcpService } from './core/remoteMcp.js';

const MCP_ENDPOINT = 'https://mcp.granola.ai/mcp';

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// The tool result's shape is not documented, only that it carries the e-mail;
// a JSON `email` field is preferred, with any e-mail in the text as fallback.
function parseAccountFromAccountInfoResult(toolResultText: string): string | null {
  const toolResult = tryParseJson(toolResultText) as { email?: unknown } | null;
  if (typeof toolResult?.email === 'string') {
    return toolResult.email;
  }
  return EMAIL_PATTERN.exec(toolResultText)?.[0] ?? null;
}

export class GranolaMcp extends RemoteMcpService {
  constructor() {
    super({
      name: 'granola-mcp',
      displayName: 'Granola MCP',
      mcpEndpoint: MCP_ENDPOINT,
      oauth: {
        authorizationEndpoint: 'https://mcp-auth.granola.ai/oauth2/authorize',
        tokenEndpoint: 'https://mcp-auth.granola.ai/oauth2/token',
        registrationEndpoint: 'https://mcp-auth.granola.ai/oauth2/register',
      },
      scopes: ['mcp'],
      info:
        'https://docs.granola.ai/help-center/sharing/integrations/mcp (tool list). ' +
        'Returns only notes of the active workspace selected in the Granola app. ' +
        'Free plan: last 30 days only, no folders, transcripts or filtered search.',
    });
  }

  override getAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    return fetchAccountFromMcpTool(
      apiCredentials,
      MCP_ENDPOINT,
      'get_account_info',
      {},
      parseAccountFromAccountInfoResult
    );
  }
}

export const GRANOLA_MCP = new GranolaMcp();
