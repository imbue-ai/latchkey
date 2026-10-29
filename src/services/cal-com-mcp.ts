/**
 * Cal.com MCP service: the hosted remote MCP server at mcp.cal.com, which
 * wraps the Cal.com API v2 (bookings, event types, schedules, availability).
 * Endpoints are from https://mcp.cal.com/.well-known/oauth-authorization-server.
 */

import type { ApiCredentials } from '../apiCredentials/base.js';
import { tryParseJson } from '../apiCredentials/account.js';
import { fetchAccountFromMcpTool, RemoteMcpService } from './core/remoteMcp.js';

const MCP_ENDPOINT = 'https://mcp.cal.com/mcp';

interface UserProfile {
  email?: string;
  username?: string;
}

// `get_me` wraps API v2 `GET /v2/me`, whose body is `{"status":"success",
// "data":{"id":...,"username":...,"email":...}}`; the tool may return either
// that envelope or the bare profile, so both are accepted.
function parseAccountFromGetMeResult(toolResultText: string): string | null {
  const toolResult = tryParseJson(toolResultText) as (UserProfile & { data?: UserProfile }) | null;
  const profile = toolResult?.data ?? toolResult;
  return profile?.email ?? profile?.username ?? null;
}

export class CalComMcp extends RemoteMcpService {
  constructor() {
    super({
      name: 'cal-com-mcp',
      displayName: 'Cal.com MCP',
      mcpEndpoint: MCP_ENDPOINT,
      oauth: {
        authorizationEndpoint: 'https://mcp.cal.com/oauth/authorize',
        tokenEndpoint: 'https://mcp.cal.com/oauth/token',
        registrationEndpoint: 'https://mcp.cal.com/oauth/register',
      },
      info:
        'https://cal.com/docs/mcp-server (tool catalog, toolsets). ' +
        'Wraps the Cal.com API v2; appending `?toolsets=bookings,availability` to the endpoint restricts the registered tools, ' +
        'and the `catalog` meta-tools reach any API v2 operation. ' +
        'Tool input schemas are only published at runtime — call `tools/list` on the MCP endpoint.',
    });
  }

  override getAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    return fetchAccountFromMcpTool(
      apiCredentials,
      MCP_ENDPOINT,
      'get_me',
      {},
      parseAccountFromGetMeResult
    );
  }
}

export const CAL_COM_MCP = new CalComMcp();
