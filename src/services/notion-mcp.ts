/**
 * Notion MCP service implementation.
 *
 * Uses OAuth 2.0 with PKCE via dynamic client registration at mcp.notion.com.
 * This is separate from the existing Notion service which uses internal integration tokens.
 */

import type { ApiCredentials } from '../apiCredentials/base.js';
import { DEFAULT_ACCOUNT, tryParseJson } from '../apiCredentials/account.js';
import type { OAuthTokenResponse } from '../oauthUtils.js';
import { fetchAccountFromMcpTool, RemoteMcpService } from './core/remoteMcp.js';

const MCP_ENDPOINT = 'https://mcp.notion.com/mcp';

/**
 * Fallback account derivation from the token-exchange response, used when the
 * MCP `fetch self` lookup fails. Notion's MCP token endpoint reports `user_id`,
 * `workspace_id` and `email_domain` (but not the full e-mail or the workspace
 * name), so the best it can offer is the opaque user id combined with the
 * opaque workspace id. The workspace id is preferred over the e-mail domain
 * because the account must tell the same user's workspaces apart.
 */
function parseAccountFromTokenResponse(tokens: OAuthTokenResponse): string {
  const { user_id, workspace_id, email_domain } = tokens as {
    user_id?: string;
    workspace_id?: string;
    email_domain?: string;
  };
  const workspacePart = workspace_id ?? email_domain;
  if (user_id !== undefined && workspacePart !== undefined) {
    return `${user_id}:${workspacePart}`;
  }
  return user_id ?? workspace_id ?? DEFAULT_ACCOUNT;
}

interface FetchSelfResult {
  workspace?: { id?: string; name?: string };
  user?: { id?: string; name?: string; type?: string; email?: string };
}

/**
 * Extract the account from a `notion-fetch` tool result for the id `self`,
 * which describes the connected workspace and user, e.g. `{"workspace":{"id":
 * "...","name":"Acme Inc"},"user":{"id":"...","name":"Jane Doe","type":
 * "person","email":"jane@example.com"}}` (possibly wrapped in a `self` key).
 *
 * A Notion MCP token is scoped to a single workspace and the authorization
 * screen makes the user pick one, so the same user signed in to two workspaces
 * holds two unrelated sets of credentials. The account therefore combines the
 * user (e-mail, or the name for bots which have none) with the workspace name,
 * as `user:workspace`, so that each workspace login lands in its own account.
 */
function parseAccountFromFetchSelfResult(toolResultText: string): string | null {
  const toolResult = tryParseJson(toolResultText) as
    | (FetchSelfResult & { self?: FetchSelfResult })
    | null;
  const self = toolResult?.self ?? toolResult;
  const userIdentity = self?.user?.email ?? self?.user?.name;
  if (userIdentity === undefined) {
    return null;
  }
  const workspaceName = self?.workspace?.name;
  return workspaceName === undefined ? userIdentity : `${userIdentity}:${workspaceName}`;
}

export class NotionMcp extends RemoteMcpService {
  constructor() {
    super({
      name: 'notion-mcp',
      displayName: 'Notion MCP',
      mcpEndpoint: MCP_ENDPOINT,
      oauth: {
        authorizationEndpoint: 'https://mcp.notion.com/authorize',
        tokenEndpoint: 'https://mcp.notion.com/token',
        registrationEndpoint: 'https://mcp.notion.com/register',
      },
      info:
        'Use Notion\'s MCP endpoints as a "normal" JSON API. ' +
        'https://developers.notion.com/guides/mcp/build-mcp-client (integration guide: server URL, transport, OAuth, worked client code). ' +
        'https://developers.notion.com/guides/mcp/mcp-supported-tools (tool catalog: names, descriptions, example prompts). ' +
        'https://spec.modelcontextprotocol.io (MCP protocol spec for JSON-RPC framing). ' +
        'Tool input schemas are not published as static docs — use authed MCP to call `tools/list` at runtime to discover them.',
    });
  }

  // MCP-audienced tokens cannot call the classic REST API, but the MCP
  // endpoint itself can reveal the identity: the `fetch` tool returns the
  // connected workspace and the current user when asked for `self`.
  override getAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    return fetchAccountFromMcpTool(
      apiCredentials,
      MCP_ENDPOINT,
      'notion-fetch',
      { id: 'self' },
      parseAccountFromFetchSelfResult
    );
  }

  // Besides the tokens, Notion's MCP token endpoint reports who authorized:
  // user_id, workspace_id and email_domain ride along in the same response.
  override accountFromTokenResponse(tokens: OAuthTokenResponse): string {
    return parseAccountFromTokenResponse(tokens);
  }
}

export const NOTION_MCP = new NotionMcp();
