/**
 * WordPress.com MCP server (Automattic): one connection covers every site on
 * the account. The endpoints come from the server's RFC 9728 / RFC 8414
 * metadata at public-api.wordpress.com/.well-known/.
 */

import type { ApiCredentials } from '../apiCredentials/base.js';
import { tryParseJson } from '../apiCredentials/account.js';
import { fetchAccountFromMcpTool, RemoteMcpService } from './core/remoteMcp.js';

const MCP_ENDPOINT = 'https://public-api.wordpress.com/wpcom/v2/mcp/v1';

/**
 * The first `email` (or, failing that, `username`) string anywhere in the
 * `profile.get` result, whose exact nesting is not documented.
 */
function findIdentity(value: unknown, key: 'email' | 'username'): string | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record[key] === 'string' && record[key] !== '') {
    return record[key];
  }
  for (const nested of Object.values(record)) {
    const found = findIdentity(nested, key);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function parseAccountFromProfileResult(toolResultText: string): string | null {
  const profile = tryParseJson(toolResultText);
  return findIdentity(profile, 'email') ?? findIdentity(profile, 'username');
}

export class WordPressComMcp extends RemoteMcpService {
  constructor() {
    super({
      name: 'wordpress-com-mcp',
      displayName: 'WordPress.com MCP',
      mcpEndpoint: MCP_ENDPOINT,
      oauth: {
        authorizationEndpoint: 'https://public-api.wordpress.com/oauth2-1/authorize',
        tokenEndpoint: 'https://public-api.wordpress.com/oauth2-1/token',
        registrationEndpoint: 'https://public-api.wordpress.com/oauth2-1/register',
      },
      // The scope the official custom-client guide asks for; which tools a
      // token may call is governed by the account's MCP settings, not scopes.
      scopes: ['auth'],
      info:
        'https://developer.wordpress.com/docs/mcp/ (overview, custom client guide). ' +
        'https://developer.wordpress.com/docs/mcp/tools-reference/ (tools and their operations). ' +
        'https://wordpress.com/support/mcp/ (enabling MCP per account and site, tool toggles). ' +
        'MCP must be enabled in the account settings first; write tools are off by default. ' +
        'Jetpack-connected self-hosted sites use the same server.',
    });
  }

  // The account facade tool operates on the authenticated user; its
  // `profile.get` operation reports the username and e-mail.
  override getAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    return fetchAccountFromMcpTool(
      apiCredentials,
      MCP_ENDPOINT,
      'wpcom-mcp-account',
      { action: 'execute', operation: 'profile.get', params: {} },
      parseAccountFromProfileResult
    );
  }
}

export const WORDPRESS_COM_MCP = new WordPressComMcp();
