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
 *     --base-api-url "https://oh.example.com/" \
 *     --login-url "https://oh.example.com/login"
 *
 * Register the instance's **root** as the base API URL, not `.../api/`:
 * OpenHost's owner API is not confined to `/api/` -- app controls such as
 * `/stop_app/<id>`, `/reload_app/<id>` and `/app_logs/<id>` are served at the
 * root -- so a `/api/`-scoped base would leave the token uninjected on those.
 * The registration also matches subdomains of the instance host: OpenHost
 * serves its client apps at `<app>.<host>`, gated by the same owner auth, so
 * the token is what signs the agent into those apps (see `registeredBaseApiUrls`).
 *
 * The registered instance supplies the login and API URLs, and the login below
 * reads them from `this.service`, so the same connector works for any instance.
 *
 * Auth: the owner signs in with a password at the instance's `/login`, which
 * sets a `session_token` cookie. The connector then spends that session once to
 * mint a never-expiring personal API token (`POST <origin>/api/tokens`, whose
 * value is returned in the response) and stores it as an `Authorization: Bearer`
 * credential -- durable, unlike the session cookie itself. The mint endpoint is
 * a fixed absolute path on the instance origin, independent of the base above.
 */

import type { Browser, BrowserContext, Response } from 'playwright';
import { ApiCredentials, AuthorizationBearer } from '../apiCredentials/base.js';
import { runCapturedAsync } from '../curl.js';
import { LoginFailedError, Service, ServiceSession } from './core/base.js';

// The cookie an OpenHost sign-in sets; its arrival marks the login complete and
// it authenticates the mint request.
const OPENHOST_SESSION_COOKIE = 'session_token';

// The owner API endpoint that mints a personal access token: an absolute path
// on the instance origin (OpenHost's owner API lives under `/api/`, even when
// the injection base is the root). OpenHost returns the token once in the body.
const OPENHOST_TOKEN_ENDPOINT = '/api/tokens';

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
 * subprocess runner swapped out. `instanceOrigin` is the instance's scheme +
 * host (e.g. `https://oh.example.com`); `tokenName` is a recognizable label the
 * user can find and revoke.
 */
export async function mintOpenhostToken(
  instanceOrigin: string,
  cookieHeader: string,
  tokenName: string
): Promise<ApiCredentials> {
  const mintUrl = new URL(OPENHOST_TOKEN_ENDPOINT, instanceOrigin).toString();
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
    // The instance origin comes from the login URL the instance was registered
    // with -- not the injection base, which is the root and would otherwise put
    // the mint endpoint at `/tokens` rather than `/api/tokens`.
    let instanceOrigin: string;
    try {
      instanceOrigin = new URL(this.service.loginUrl).origin;
    } catch {
      throw new LoginFailedError('OpenHost must be registered with a login URL for its instance.');
    }
    const mintUrl = new URL(OPENHOST_TOKEN_ENDPOINT, instanceOrigin).toString();
    // Send what the browser holds for the mint URL -- the session cookie the
    // sign-in set, plus any others (a CSRF cookie, say) scoped to it.
    const cookies = await context.cookies(mintUrl);
    if (cookies.length === 0) {
      throw new LoginFailedError('No OpenHost session cookies were available to mint a token.');
    }
    const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    return mintOpenhostToken(instanceOrigin, cookieHeader, this.generateAppName());
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
    '--base-api-url "https://<host>/" --login-url "https://<host>/login". ' +
    'Use the instance root as the base URL (OpenHost serves owner endpoints outside /api/ too); ' +
    'the token is injected for the host and its app subdomains (<app>.<host>) alike. ' +
    'Signing in mints a personal API token and stores it as a bearer credential.';
  // No fixed host to check against; a registered instance reports its own status.
  readonly credentialCheckCurlArguments = [] as const;

  // OpenHost serves the owner API on the instance host and its client apps on
  // subdomains of it (`<app>.<host>`). The owner token authenticates into those
  // apps too -- signing into an app is the point of the token -- so a registered
  // instance matches the host and any subdomain of it, not just the bare host.
  override registeredBaseApiUrls(baseApiUrl: string): readonly (string | RegExp)[] {
    let hostname: string;
    try {
      hostname = new URL(baseApiUrl).hostname;
    } catch {
      // A base that does not parse can't be widened; match it literally.
      return [baseApiUrl];
    }
    const escapedHost = hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // `([a-z0-9-]+\.)*` matches zero labels (the bare host) or any number of
    // subdomain labels; the optional port and required `/` keep a lookalike
    // domain (`<host>.evil.com`) from matching.
    return [new RegExp(`^https?://([a-z0-9-]+\\.)*${escapedHost}(:\\d+)?/`, 'i')];
  }

  // `/dashboard` is owner-guarded: a valid owner credential gets 200, anything
  // else a redirect to /login. curl doesn't follow redirects and the default
  // check accepts only 200, so this reports valid vs. invalid correctly. (The
  // official `oh` CLI validates a token exactly this way.)
  override registeredCredentialCheckCurlArguments(baseApiUrl: string): readonly string[] {
    try {
      return [`${new URL(baseApiUrl).origin}/dashboard`];
    } catch {
      return [];
    }
  }

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
