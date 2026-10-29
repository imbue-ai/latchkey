/**
 * Trello MCP service: Atlassian's hosted MCP server for Trello (separate from
 * the Rovo MCP server, which does not cover Trello). Endpoints and scopes come
 * from https://mcp.trello.com/.well-known/oauth-protected-resource/v1 and the
 * named tenant's RFC 8414 metadata at auth.atlassian.com.
 */

import type { ApiCredentials } from '../apiCredentials/base.js';
import { tryParseJson } from '../apiCredentials/account.js';
import { fetchAccountFromMcpTool, RemoteMcpService } from './core/remoteMcp.js';

const MCP_ENDPOINT = 'https://mcp.trello.com/v1';

interface MemberProfile {
  email?: string;
  username?: string;
  fullName?: string;
}

// The `get_me` result is a Trello member object; the e-mail is preferred,
// then the username, then the display name.
function parseAccountFromMemberProfile(toolResultText: string): string | null {
  const member = tryParseJson(toolResultText) as MemberProfile | null;
  return member?.email ?? member?.username ?? member?.fullName ?? null;
}

export class TrelloMcp extends RemoteMcpService {
  constructor() {
    super({
      name: 'trello-mcp',
      displayName: 'Trello MCP',
      mcpEndpoint: MCP_ENDPOINT,
      oauth: {
        authorizationEndpoint: 'https://auth.atlassian.com/authorize',
        tokenEndpoint: 'https://auth.atlassian.com/oauth/token',
        registrationEndpoint:
          'https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3/dcr/register',
      },
      scopes: [
        'offline_access',
        'read:me',
        'read:account',
        'read:board:trello',
        'write:board:trello',
        'read:organization:trello',
        'write:organization:trello',
        'read:member:trello',
        'read:member.inbox:trello',
        'write:member.inbox:trello',
        'read:member.planner:trello',
        'write:member.planner:trello',
      ],
      info:
        'https://github.com/atlassian/trello-mcp-server (capabilities, consent flow, roadmap), https://trello.com/mcp. ' +
        'Works on all Trello plans; the consent screen picks a single workspace. ' +
        'Covers boards, lists, cards, checklists, Planner and Inbox; no comments or attachments yet.',
    });
  }

  // The `trelloReadMember` tool's `get_me` action returns the authenticated
  // member's profile (documented in the repo's `trello-use` skill).
  override getAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    return fetchAccountFromMcpTool(
      apiCredentials,
      MCP_ENDPOINT,
      'trelloReadMember',
      { action: 'get_me' },
      parseAccountFromMemberProfile
    );
  }
}

export const TRELLO_MCP = new TrelloMcp();
