/**
 * Vercel MCP service: Vercel's remote MCP server (beta), a thin OAuth-protected
 * JSON-RPC API over the Vercel platform. Endpoints come from
 * https://mcp.vercel.com/.well-known/oauth-protected-resource and the
 * authorization server metadata it names at https://vercel.com.
 */

import type { ApiCredentials } from '../apiCredentials/base.js';
import { tryParseJson } from '../apiCredentials/account.js';
import { fetchAccountFromMcpTool, RemoteMcpService } from './core/remoteMcp.js';

const MCP_ENDPOINT = 'https://mcp.vercel.com/';

interface AuthUser {
  email?: string;
  username?: string;
}

// `get_auth_user` describes the authenticated user, mirroring REST `GET /v2/user`,
// whose payload wraps the user in a `user` key.
function parseAccountFromAuthUserResult(toolResultText: string): string | null {
  const toolResult = tryParseJson(toolResultText) as (AuthUser & { user?: AuthUser }) | null;
  const user = toolResult?.user ?? toolResult;
  return user?.email ?? user?.username ?? null;
}

export class VercelMcp extends RemoteMcpService {
  constructor() {
    super({
      name: 'vercel-mcp',
      displayName: 'Vercel MCP',
      mcpEndpoint: MCP_ENDPOINT,
      oauth: {
        authorizationEndpoint: 'https://vercel.com/oauth/authorize',
        tokenEndpoint: 'https://api.vercel.com/login/oauth/token',
        registrationEndpoint: 'https://api.vercel.com/login/oauth/register',
      },
      scopes: ['openid', 'email', 'profile', 'offline_access'],
      info:
        'https://vercel.com/docs/mcp/vercel-mcp (beta; tool catalog). ' +
        'Project-scoped servers live at https://mcp.vercel.com/<team-slug>/<project-slug>.',
    });
  }

  override getAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    return fetchAccountFromMcpTool(
      apiCredentials,
      MCP_ENDPOINT,
      'get_auth_user',
      {},
      parseAccountFromAuthUserResult
    );
  }
}

export const VERCEL_MCP = new VercelMcp();
