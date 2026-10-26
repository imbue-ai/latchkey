/**
 * Coda MCP service: the remote MCP server of Coda (now Superhuman Docs) at
 * coda.io. Endpoints come from https://coda.io/.well-known/oauth-protected-resource/apis/mcp
 * and https://coda.io/.well-known/oauth-authorization-server; the successor
 * server at docs.superhuman.com is served by the same credentials.
 */

import type { ApiCredentials } from '../apiCredentials/base.js';
import { tryParseJson } from '../apiCredentials/account.js';
import { fetchAccountFromMcpTool, RemoteMcpService } from './core/remoteMcp.js';

const MCP_ENDPOINT = 'https://coda.io/apis/mcp';

/**
 * Extract the account from a `whoami` tool result, documented as
 * `{ userId, name, email, workspaces[] }`.
 */
function parseAccountFromWhoamiResult(toolResultText: string): string | null {
  const whoami = tryParseJson(toolResultText) as { email?: string; name?: string } | null;
  return whoami?.email ?? whoami?.name ?? null;
}

export class CodaMcp extends RemoteMcpService {
  constructor() {
    super({
      name: 'coda-mcp',
      displayName: 'Coda MCP',
      mcpEndpoint: MCP_ENDPOINT,
      oauth: {
        authorizationEndpoint: 'https://coda.io/v4/api/oauth2/authorize',
        tokenEndpoint: 'https://coda.io/v4/api/oauth2/token',
        registrationEndpoint: 'https://coda.io/v4/api/oauth2/register',
      },
      scopes: ['mcp:all'],
      additionalBaseApiUrls: ['https://docs.superhuman.com/'],
      // The authorization server supports the authorization_code grant only.
      issuesRefreshTokens: false,
      info:
        'https://coda.io/resources/mcp/tools-and-endpoints (tool catalog: names, key parameters). ' +
        'https://help.superhuman.com/hc/en-us/articles/46210076980365 (connection guide). ' +
        'Tool names are declared unstable while in beta; discover them with a `tools/list` JSON-RPC call. ' +
        'This is the legacy Coda endpoint, slated for deprecation in favour of https://docs.superhuman.com/apis/mcp (same tools). ' +
        'OAuth grants read & write access and no refresh token, so log in again when the token expires.',
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

export const CODA_MCP = new CodaMcp();
