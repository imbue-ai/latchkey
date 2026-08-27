/**
 * ChatGPT service implementation.
 *
 * Unlike claude.ai, the ChatGPT web app does not authenticate its API with the
 * session cookie: the cookie authenticates the *page*, which then calls
 * `/api/auth/session` to mint a short-lived bearer token, and it is that token
 * `/backend-api/...` wants. So this cannot be the generic cookie-capture flow —
 * capturing `__Secure-next-auth.session-token` would store something the API
 * refuses. Instead the login watches for the session response the app fetches
 * for itself and lifts `accessToken` out of it, which is exactly the value a
 * user would otherwise read out of DevTools and paste into `auth set`.
 *
 * The token is short-lived (hours), so `credentialStatus` going `invalid` is
 * routine rather than a sign that anything is wrong; signing in again mints a
 * fresh one. There is no refresh path: the refresh material is the cookie,
 * which stays in the browser profile and never reaches us.
 *
 * NOTE: chatgpt.com is behind Cloudflare's managed-challenge system, which
 * fingerprints TLS handshakes and answers vanilla curl with an HTTP 403
 * interstitial. The browser login is unaffected (it drives a real Chrome), but
 * `checkApiCredentials` and {@link getAccount} go out over curl, so with a
 * stock curl they report `invalid` / no account even for a freshly minted
 * token. Point `LATCHKEY_CURL` at a Chrome-impersonating curl for accurate
 * answers.
 */

import type { Response } from 'playwright';
import { type ApiCredentials, AuthorizationBearer } from '../apiCredentials/base.js';
import { fetchAccountFromEndpoint, tryParseJson } from '../apiCredentials/account.js';
import { Service, SimpleServiceSession } from './core/base.js';

/**
 * Scoped to the API rather than the whole origin: the bearer token is only
 * meaningful to `/backend-api/`, and the rest of chatgpt.com is the web app,
 * which authenticates itself with its own cookie.
 */
const CHATGPT_API_BASE_URL = 'https://chatgpt.com/backend-api/';

const CHATGPT_LOGIN_URL = 'https://chatgpt.com/auth/login';

/** Returns the signed-in user, including `email`. Also the credential check. */
const CHATGPT_ME_ENDPOINT = 'https://chatgpt.com/backend-api/me';

/**
 * The endpoint the web app calls to mint the bearer token for its own API
 * calls. Matched on path so the query string NextAuth sometimes appends does
 * not have to be predicted.
 */
const CHATGPT_SESSION_ENDPOINT_PATTERN = /^https:\/\/chatgpt\.com\/api\/auth\/session(\?|$)/;

class ChatgptServiceSession extends SimpleServiceSession {
  protected async getApiCredentialsFromResponse(
    response: Response
  ): Promise<ApiCredentials | null> {
    if (!CHATGPT_SESSION_ENDPOINT_PATTERN.test(response.url())) {
      return null;
    }

    // A signed-out visitor gets this same endpoint answering `{}`, so the
    // presence of a token — not the request having happened — is the signal
    // that the login completed.
    try {
      const data = tryParseJson(await response.text()) as { accessToken?: unknown } | null;
      if (typeof data?.accessToken === 'string' && data.accessToken !== '') {
        return new AuthorizationBearer(data.accessToken);
      }
    } catch {
      // Ignore errors reading the response body.
    }

    return null;
  }
}

export class Chatgpt extends Service {
  readonly name = 'chatgpt';
  readonly displayName = 'ChatGPT';
  readonly baseApiUrls = [CHATGPT_API_BASE_URL] as const;
  readonly loginUrl = CHATGPT_LOGIN_URL;

  readonly info =
    'The ChatGPT web app API (not the OpenAI platform API at api.openai.com, which uses ' +
    'its own API key). Conversations are at /backend-api/conversations and ' +
    '/backend-api/conversation/{id}. The bearer token is short-lived, so expect to sign ' +
    'in again periodically. Cloudflare rejects vanilla curl here, so point LATCHKEY_CURL ' +
    "at a Chrome-impersonating curl or every request — including this service's own " +
    'credential check — comes back HTTP 403.';

  readonly credentialCheckCurlArguments = [CHATGPT_ME_ENDPOINT] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer <access-token>"`;
  }

  override getAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    return fetchAccountFromEndpoint(
      apiCredentials,
      this.credentialCheckCurlArguments,
      (responseBody) => {
        const data = tryParseJson(responseBody) as { email?: string } | null;
        return data?.email ?? null;
      }
    );
  }

  override getSession(appNamePrefix: string): ChatgptServiceSession {
    return new ChatgptServiceSession(this, appNamePrefix);
  }
}

export const CHATGPT = new Chatgpt();
