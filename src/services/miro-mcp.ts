/**
 * Miro MCP service: Miro's remote MCP server (boards, canvas, comments,
 * images, prototypes) at mcp.miro.com, behind OAuth 2.1 with dynamic client
 * registration. Endpoints and scopes come from the server's own
 * `/.well-known/oauth-authorization-server` metadata.
 */

import { DEFAULT_ACCOUNT, tryParseJson } from '../apiCredentials/account.js';
import type { OAuthTokenResponse } from '../oauthUtils.js';
import { RemoteMcpService } from './core/remoteMcp.js';

/**
 * The e-mail from the OIDC `id_token` the token endpoint returns alongside the
 * access token when `openid email` are among the scopes, as documented at
 * https://developers.miro.com/docs/oidc-support-for-miro-mcp. The signature
 * is not verified: the token arrives over TLS straight from the issuer.
 */
function parseEmailFromIdToken(tokens: OAuthTokenResponse): string | null {
  const idToken = (tokens as { id_token?: unknown }).id_token;
  if (typeof idToken !== 'string') {
    return null;
  }
  const payloadSegment = idToken.split('.')[1];
  if (payloadSegment === undefined) {
    return null;
  }
  const payload = tryParseJson(Buffer.from(payloadSegment, 'base64url').toString('utf-8')) as {
    email?: unknown;
  } | null;
  return typeof payload?.email === 'string' ? payload.email : null;
}

export class MiroMcp extends RemoteMcpService {
  constructor() {
    super({
      name: 'miro-mcp',
      displayName: 'Miro MCP',
      mcpEndpoint: 'https://mcp.miro.com/',
      oauth: {
        authorizationEndpoint: 'https://mcp.miro.com/authorize',
        tokenEndpoint: 'https://mcp.miro.com/token',
        registrationEndpoint: 'https://mcp.miro.com/register',
      },
      scopes: ['boards:read', 'boards:write', 'openid', 'email'],
      info:
        'https://developers.miro.com/docs/miro-mcp-tools (tool catalog), ' +
        'https://developers.miro.com/docs/connecting-to-miro-mcp (server URL, OAuth, team selection), ' +
        'https://developers.miro.com/docs/miro-mcp-server-frequently-asked-questions. ' +
        'The token is scoped to the single team picked at consent, and a user holds one team ' +
        'connection at a time: authorizing another team or client supersedes the previous token. ' +
        'Enterprise orgs need an admin to enable the MCP server.',
    });
  }

  override accountFromTokenResponse(tokens: OAuthTokenResponse): string {
    return parseEmailFromIdToken(tokens) ?? DEFAULT_ACCOUNT;
  }
}

export const MIRO_MCP = new MiroMcp();
