/**
 * OpenHost service implementation.
 *
 * OpenHost (https://github.com/imbue-openhost/openhost) is a self-hosted app
 * platform: every user runs their own instance on their own host, so there is
 * no canonical API host to pin. This connector is therefore a *family* -- a
 * template with no URL of its own -- that a user registers their instance
 * against:
 *
 *   latchkey services register my-openhost \
 *     --service-family openhost \
 *     --base-api-url "https://oh.example.com/api/" \
 *     --login-url "https://oh.example.com/login"
 *
 * The registered instance supplies the login and API URLs, and the login below
 * reads them from `this.service`, so the same connector works for any instance.
 *
 * Auth: the owner signs in with a password at the instance's `/login`, which
 * sets a `session_token` cookie. The connector then spends that session once to
 * mint a never-expiring personal API token (`POST <base>tokens`, whose value is
 * returned in the response) and stores it as an `Authorization: Bearer`
 * credential -- durable, unlike the session cookie itself.
 */

import type { Browser, BrowserContext, Response } from 'playwright';
import { ApiCredentials, AuthorizationBearer } from '../apiCredentials/base.js';
import { runCapturedAsync } from '../curl.js';
import { LoginFailedError, Service, ServiceSession } from './core/base.js';

// The cookie an OpenHost sign-in sets; its arrival marks the login complete and
// it authenticates the mint request.
const OPENHOST_SESSION_COOKIE = 'session_token';

// The owner API path, relative to the instance's base API URL, that mints a
// personal access token. OpenHost returns the token's value once in the body.
const OPENHOST_TOKEN_PATH = 'tokens';

/**
 * Whether a `Set-Cookie` header assigns a non-empty value to `name`.
 */
export function setsCookie(setCookieHeaderValue: string, name: string): boolean {
  const [assignment = ''] = setCookieHeaderValue.split(';');
  const separatorIndex = assignment.indexOf('=');
  if (separatorIndex <= 0) {
    return false;
  }
  return (
    assignment.slice(0, separatorIndex).trim() === name &&
    assignment.slice(separatorIndex + 1).trim() !== ''
  );
}

/**
 * Mint an OpenHost API token by spending the signed-in session: POST the
 * instance's create-token endpoint with the session's cookies (plus a
 * same-origin Origin header, so it passes cookie-auth and CSRF origin checks)
 * and read the token out of the JSON response.
 *
 * Separated from the session so the network step is testable with the async
 * subprocess runner swapped out. `baseApiUrl` is the instance's base API URL
 * (e.g. `https://oh.example.com/api/`); `tokenName` is a recognizable label the
 * user can find and revoke.
 */
export async function mintOpenhostToken(
  baseApiUrl: string,
  cookieHeader: string,
  tokenName: string
): Promise<ApiCredentials> {
  const mintUrl = new URL(OPENHOST_TOKEN_PATH, baseApiUrl).toString();
  const origin = new URL(mintUrl).origin;
  const result = await runCapturedAsync([
    '-sS',
    '-X',
    'POST',
    mintUrl,
    '-H',
    'Content-Type: application/json',
    '-H',
    `Cookie: ${cookieHeader}`,
    '-H',
    `Origin: ${origin}`,
    '--data',
    JSON.stringify({ name: tokenName, expiry_hours: 'never' }),
  ]);
  if (result.returncode !== 0) {
    throw new LoginFailedError(`Minting an OpenHost API token failed: ${result.stderr.trim()}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new LoginFailedError('OpenHost did not return JSON when minting a token.');
  }
  const token =
    typeof parsed === 'object' &&
    parsed !== null &&
    typeof (parsed as { token?: unknown }).token === 'string'
      ? (parsed as { token: string }).token
      : '';
  if (token === '') {
    throw new LoginFailedError('OpenHost returned no token when minting.');
  }
  return new AuthorizationBearer(token);
}

/**
 * One run of the login. The login phase waits for the session cookie; finalizing
 * spends that session on a single mint call and keeps the token it returns.
 *
 * URLs come from `this.service`, which -- for a registered instance -- is the
 * registered service carrying the instance's login and API URLs.
 */
class OpenhostServiceSession extends ServiceSession {
  private isLoggedIn = false;

  async onResponse(response: Response): Promise<void> {
    if (this.isLoggedIn) {
      return;
    }
    for (const header of await response.headersArray()) {
      if (
        header.name.toLowerCase() === 'set-cookie' &&
        setsCookie(header.value, OPENHOST_SESSION_COOKIE)
      ) {
        this.isLoggedIn = true;
        return;
      }
    }
  }

  protected isLoginComplete(): boolean {
    return this.isLoggedIn;
  }

  protected async finalizeCredentials(
    _browser: Browser,
    context: BrowserContext,
    _oldCredentials?: ApiCredentials
  ): Promise<ApiCredentials | null> {
    const baseApiUrl = this.service.baseApiUrls[0];
    if (typeof baseApiUrl !== 'string') {
      throw new LoginFailedError(
        'OpenHost must be registered with a base API URL for its instance.'
      );
    }
    const mintUrl = new URL(OPENHOST_TOKEN_PATH, baseApiUrl).toString();
    // Send what the browser holds for the mint URL -- the session cookie the
    // sign-in set, plus any others (a CSRF cookie, say) scoped to it.
    const cookies = await context.cookies(mintUrl);
    if (cookies.length === 0) {
      throw new LoginFailedError('No OpenHost session cookies were available to mint a token.');
    }
    const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    return mintOpenhostToken(baseApiUrl, cookieHeader, this.generateAppName());
  }
}

/**
 * The OpenHost family. It carries no URLs of its own: an instance is registered
 * with `--service-family openhost`, and its `--base-api-url` / `--login-url`
 * drive the login above.
 */
export class Openhost extends Service {
  readonly name = 'openhost';
  readonly displayName = 'OpenHost';
  // No canonical host: OpenHost is always self-hosted. An empty list matches no
  // URL, so the bare family injects nothing; the registered instance's own base
  // API URL is what requests match against.
  readonly baseApiUrls = [] as const;
  // Supplied per instance via `--login-url`; the family template has none.
  readonly loginUrl = '';
  readonly info =
    'Self-hosted OpenHost (https://github.com/imbue-openhost/openhost). Register an instance: ' +
    'latchkey services register <name> --service-family openhost ' +
    '--base-api-url "https://<host>/api/" --login-url "https://<host>/login". ' +
    'Signing in mints a personal API token and stores it as a bearer credential.';
  // No fixed host to check against; a registered instance reports its own status.
  readonly credentialCheckCurlArguments = [] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
  }

  // An OpenHost instance has a single owner, so its token needs no account
  // label; return null and let the gateway use the default account.
  getAccount(_apiCredentials: ApiCredentials): Promise<string | null> {
    return Promise.resolve(null);
  }

  override getSession(appNamePrefix: string): OpenhostServiceSession {
    return new OpenhostServiceSession(this, appNamePrefix);
  }
}

export const OPENHOST = new Openhost();
