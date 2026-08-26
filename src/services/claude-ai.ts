/**
 * claude.ai service implementation.
 *
 * The claude.ai web app authenticates with a single `sessionKey` cookie, so
 * the browser login is the generic {@link CookieCaptureLoginFlow} rather than
 * anything service-specific: open the login page, watch for `sessionKey` to be
 * set, store it as a `Cookie:` header. That is the same credential shape
 * `latchkey auth set claude-ai -H "Cookie: sessionKey=..."` produces, so an
 * account established either way is indistinguishable to callers.
 *
 * This is the *web app* API (`claude.ai/api/...`), not the Anthropic developer
 * API at `api.anthropic.com` — different host, different credential (an
 * `x-api-key`), and nothing here applies to it.
 *
 * NOTE: claude.ai sits behind Cloudflare's managed-challenge system, which
 * fingerprints TLS handshakes and rejects vanilla curl with an HTTP 403
 * interstitial. The browser login is unaffected (it drives a real Chrome), but
 * `checkApiCredentials` and {@link getAccount} both go out over curl, so with
 * a stock curl they report `invalid` / no account even when the stored cookie
 * is perfectly good. Point `LATCHKEY_CURL` at a Chrome-impersonating curl to
 * get accurate answers.
 */

import type { ApiCredentials } from '../apiCredentials/base.js';
import { fetchAccountFromEndpoint, tryParseJson } from '../apiCredentials/account.js';
import { Service, type ServiceSession } from './core/base.js';
import { CookieCaptureLoginFlow } from './core/loginFlows/cookieCapture.js';

/**
 * The whole origin, matching what users who registered this service by hand
 * were told to pass as `--base-api-url`, so switching to the built-in service
 * does not narrow what their stored credential is offered to.
 */
const CLAUDE_AI_ORIGIN = 'https://claude.ai/';

const CLAUDE_AI_LOGIN_URL = 'https://claude.ai/login';

/**
 * Lists the organizations the session can see. Used as the credential check
 * because it is the smallest authenticated response the web app exposes and
 * answers 401/403 when the cookie is missing or stale.
 */
const CLAUDE_AI_ORGANIZATIONS_ENDPOINT = 'https://claude.ai/api/organizations';

/**
 * The signed-in account, including `email_address`. A separate endpoint from
 * the credential check: the organization list carries only org names (a
 * personal org is named after its owner inconsistently), so it cannot identify
 * the account, and this response is ~4x larger — worth fetching once at login,
 * not on every credential check.
 */
const CLAUDE_AI_ACCOUNT_ENDPOINT = 'https://claude.ai/api/account';

/** The session cookie the web app authenticates with. */
const CLAUDE_AI_SESSION_COOKIE = 'sessionKey';

export class ClaudeAi extends Service {
  readonly name = 'claude-ai';
  readonly displayName = 'Claude';
  readonly baseApiUrls = [CLAUDE_AI_ORIGIN] as const;
  readonly loginUrl = CLAUDE_AI_LOGIN_URL;

  readonly info =
    'The claude.ai web app API (not the Anthropic developer API at api.anthropic.com, ' +
    'which uses an x-api-key instead). Conversations live under ' +
    '/api/organizations/{org_uuid}/chat_conversations. Cloudflare rejects vanilla curl ' +
    'here, so point LATCHKEY_CURL at a Chrome-impersonating curl or every request — ' +
    "including this service's own credential check — comes back HTTP 403.";

  readonly credentialCheckCurlArguments = [CLAUDE_AI_ORGANIZATIONS_ENDPOINT] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Cookie: sessionKey=<your-session-key>"`;
  }

  override getAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    return fetchAccountFromEndpoint(
      apiCredentials,
      [CLAUDE_AI_ACCOUNT_ENDPOINT],
      (responseBody) => {
        const data = tryParseJson(responseBody) as { email_address?: string } | null;
        return data?.email_address ?? null;
      }
    );
  }

  /**
   * Nothing claude.ai-specific happens during login, so the generic
   * cookie-capture flow is configured here rather than reimplemented: it
   * finishes as soon as `sessionKey` has been set for this origin.
   */
  override getSession(appNamePrefix: string): ServiceSession {
    return new CookieCaptureLoginFlow({
      cookieKeys: [CLAUDE_AI_SESSION_COOKIE],
      cookieUrl: CLAUDE_AI_ORIGIN,
    }).createSession(this, appNamePrefix);
  }
}

export const CLAUDE_AI = new ClaudeAi();
