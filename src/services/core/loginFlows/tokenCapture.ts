/**
 * A generic browser login for services whose credential is a token the web app
 * mints for itself: open a URL, and lift a token out of the JSON body of a
 * named endpoint, either as it goes by or by asking for it.
 *
 * Watching alone is not enough, because a web app calls its own mint endpoint
 * when it needs a token and not otherwise. ChatGPT is the case that showed
 * this: it signs in, renders the app, and never calls `/api/auth/session` —
 * the endpoint is there and answers with a token, but a login that only
 * listens waits for a request that is never made. So once the browser reaches
 * the endpoint's origin, this flow also asks it directly.
 *
 * This is the counterpart to `cookie-capture`, for the other common shape. In a
 * cookie-authenticated service the cookie *is* the API credential, so capturing
 * it is enough. In a token-minting one the cookie authenticates the *page*,
 * which then calls an endpoint of its own to obtain a short-lived token, and it
 * is that token the API wants — capturing the cookie would store something the
 * API refuses. Single-page apps built on NextAuth are the common case, where
 * the mint endpoint is conventionally `/api/auth/session`.
 *
 * Nothing here is service-specific: which endpoint to watch, which field holds
 * the token, and which header carries it all come from whoever registered the
 * service, as the parameters of the `token-capture` login flow.
 *
 * Two consequences of capturing a minted token are worth knowing, and are the
 * registrant's to accept rather than this flow's to solve:
 *
 * - **The token expires, and there is no refresh path.** The refresh material
 *   is the browser session, which stays in the browser profile and never
 *   reaches us. A credential going invalid is routine; signing in again mints
 *   a fresh one.
 * - **The token is only as scoped as the service says.** A minted token is
 *   usually broader than an API key a user would issue deliberately.
 */

import type { Page, Response } from 'playwright';
import { z } from 'zod';
import { type ApiCredentials, RawCurlCredentials } from '../../../apiCredentials/base.js';
import { Service, SimpleServiceSession, type ServiceSession } from '../base.js';
import { parseLoginFlowParams, type LoginFlow, type LoginFlowClass } from './base.js';

/** The placeholder a header template puts the captured token in. */
const TOKEN_PLACEHOLDER = '{token}';

/**
 * The header a captured token goes into when the registration does not say.
 * Bearer is what the great majority of token-minting web APIs expect.
 */
const DEFAULT_HEADER_TEMPLATE = `Authorization: Bearer ${TOKEN_PLACEHOLDER}`;

/**
 * How often the endpoint is asked, once the browser is somewhere it can be
 * asked from. Slow enough not to hammer a service through a login that takes a
 * while, quick enough that the login ends promptly once a token exists.
 */
const TOKEN_REQUEST_INTERVAL_MS = 2_000;

/**
 * Identity of an endpoint for matching purposes: origin and path, with the
 * query string and fragment dropped.
 *
 * Matching this way rather than on the URL verbatim is deliberate. A mint
 * endpoint is commonly called with a cache-busting or callback parameter the
 * registrant cannot predict — NextAuth appends one to `/api/auth/session` — and
 * requiring the whole URL to match would silently never fire. The alternative,
 * letting registrations carry a regular expression, puts an injection and
 * catastrophic-backtracking surface into stored configuration to buy a
 * generality nothing has asked for.
 */
function endpointIdentity(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

/**
 * Read a dotted path out of parsed JSON — `accessToken`, or `data.token` when
 * the endpoint nests it.
 *
 * Returns null for anything that is not a non-empty string, which is what makes
 * the token's *presence* the completion signal: a signed-out visitor commonly
 * gets the same endpoint answering `{}` or `{"accessToken": null}`, and the
 * request having happened must not be mistaken for a finished login.
 */
function readTokenAtPath(body: unknown, path: readonly string[]): string | null {
  let current: unknown = body;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === 'string' && current !== '' ? current : null;
}

const TokenCaptureParamsSchema = z
  .object({
    /**
     * The endpoint whose response carries the token. Compared by origin and
     * path, so a query string does not have to be predicted.
     */
    tokenUrl: z.string().url(),
    /**
     * Where the token sits in the JSON body. Dotted for a nested field; each
     * segment is a literal key, so a key containing a dot cannot be addressed —
     * no such endpoint has come up, and leaving it out keeps the syntax
     * obvious.
     */
    tokenField: z.string().min(1),
    /**
     * The header the token is stored as. Must contain `{token}`, and must look
     * like a header, so that a mistake here is caught at registration rather
     * than as a puzzling 401 after a successful-looking login.
     */
    header: z
      .string()
      .min(1)
      .refine((value) => value.includes(TOKEN_PLACEHOLDER), {
        message: `must contain the ${TOKEN_PLACEHOLDER} placeholder`,
      })
      .refine((value) => /^[^:\s]+:/.test(value), {
        message: "must be a header, as in 'Authorization: Bearer {token}'",
      })
      .optional(),
  })
  .strict();

type TokenCaptureParams = z.infer<typeof TokenCaptureParamsSchema>;

/**
 * Ask the endpoint from inside the page, so the request is the browser's own:
 * same cookies, same bot-detection clearance the app itself enjoys. Returns
 * null when the endpoint refuses the request.
 */
function requestTokenBody(page: Page, tokenUrl: string): Promise<string | null> {
  return page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: 'include' });
    return response.ok ? await response.text() : null;
  }, tokenUrl);
}

/** Store the captured token the way `latchkey auth set -H` would. */
function buildTokenCredentials(headerTemplate: string, token: string): ApiCredentials {
  return new RawCurlCredentials(['-H', headerTemplate.replaceAll(TOKEN_PLACEHOLDER, token)]);
}

/**
 * One run of the flow. The endpoint is both watched and asked, and whichever
 * produces a token first ends the login.
 */
class TokenCaptureSession extends SimpleServiceSession {
  private readonly tokenUrl: URL;
  private readonly tokenEndpointIdentity: string;
  private readonly tokenPath: readonly string[];
  private readonly headerTemplate: string;
  private lastRequestedAt = 0;

  constructor(
    service: Service,
    appNamePrefix: string,
    tokenUrl: URL,
    tokenPath: readonly string[],
    headerTemplate: string
  ) {
    super(service, appNamePrefix);
    this.tokenUrl = tokenUrl;
    this.tokenEndpointIdentity = endpointIdentity(tokenUrl);
    this.tokenPath = tokenPath;
    this.headerTemplate = headerTemplate;
  }

  /**
   * Credentials from one body of the endpoint, or null when it carries no
   * token — including when it is not JSON at all, which is how a bot-detection
   * interstitial or an error page arrives.
   */
  private credentialsFromBody(rawBody: string): ApiCredentials | null {
    let token: string | null;
    try {
      token = readTokenAtPath(JSON.parse(rawBody), this.tokenPath);
    } catch {
      return null;
    }
    return token === null ? null : buildTokenCredentials(this.headerTemplate, token);
  }

  protected async getApiCredentialsFromResponse(
    response: Response
  ): Promise<ApiCredentials | null> {
    let responseUrl: URL;
    try {
      responseUrl = new URL(response.url());
    } catch {
      // Not a URL we can compare — a data: or blob: response, say.
      return null;
    }
    if (endpointIdentity(responseUrl) !== this.tokenEndpointIdentity) {
      return null;
    }

    let rawBody: string;
    try {
      rawBody = await response.text();
    } catch {
      // The body is no longer retrievable — a redirect, or a response the page
      // navigated away from. Keep waiting rather than fail the login; the next
      // request to the endpoint, ours or the app's, gets another chance.
      return null;
    }

    return this.credentialsFromBody(rawBody);
  }

  /**
   * Ask the endpoint ourselves, because an app only calls it when it wants a
   * token and may never want one while we are watching.
   *
   * This waits for the browser to arrive on the endpoint's own origin. The
   * request is made from inside the page so that it carries the session, and a
   * cross-origin read of the response would be refused — mid-login the browser
   * is commonly parked on an identity provider, where there is nothing to ask.
   */
  override async whileWaitingForLogin(page: Page): Promise<void> {
    if (Date.now() - this.lastRequestedAt < TOKEN_REQUEST_INTERVAL_MS) {
      return;
    }

    let pageUrl: URL;
    try {
      pageUrl = new URL(page.url());
    } catch {
      return;
    }
    if (pageUrl.origin !== this.tokenUrl.origin) {
      return;
    }
    this.lastRequestedAt = Date.now();

    let rawBody: string | null;
    try {
      rawBody = await requestTokenBody(page, this.tokenUrl.href);
    } catch {
      // The page navigated out from under the request, or the endpoint could
      // not be reached. The next poll asks again; a browser the user closed is
      // caught by the wait loop itself.
      return;
    }
    if (rawBody === null) {
      return;
    }

    const credentials = this.credentialsFromBody(rawBody);
    // A response may have produced credentials while this request was in
    // flight, and the first token captured is the one the login keeps.
    if (credentials !== null && this.apiCredentials === null) {
      this.apiCredentials = credentials;
    }
  }
}

/**
 * The flow. Its statics are the kind of automation — what `--login-flow`
 * selects — and an instance is that kind configured with one service's
 * parameters, ready to create a session per login.
 */
export class TokenCaptureLoginFlow implements LoginFlow {
  /** Value of `--login-flow`. Not `name`, which every class already has. */
  static readonly flowName = 'token-capture';

  static readonly summary =
    'Open the login URL and capture a token the web app mints for itself, from the JSON ' +
    'body of a named endpoint.';

  static readonly details = [
    'Parameters:',
    '  tokenUrl    Full URL, including the scheme, of the endpoint whose response',
    '              carries the token. Required. Matched on origin and path, so a',
    '              query string the app appends does not have to be predicted.',
    '  tokenField  Where the token sits in the JSON body. Required. Dotted for a',
    '              nested field, as in "data.accessToken".',
    '  header      Header to store the token as. Optional; defaults to',
    `              "${DEFAULT_HEADER_TEMPLATE}". Must contain ${TOKEN_PLACEHOLDER}.`,
    '',
    'For services where the cookie authenticates the page rather than the API,',
    'and the page calls an endpoint of its own to mint a short-lived token. Use',
    'cookie-capture instead when the cookie is itself the API credential.',
    '',
    'The endpoint is both watched and asked: once the browser reaches its',
    'origin, it is requested from inside the page every couple of seconds, so a',
    'web app that never calls it unprompted still works. Either way the login',
    'finishes when it answers with a non-empty token, not when it is merely',
    'requested: a signed-out visitor commonly gets the same endpoint answering',
    '`{}`. A token minted this way expires and cannot be refreshed — the refresh',
    'material stays in the browser — so expect to sign in again periodically.',
    '',
    'Example:',
    '  $ latchkey services register my-app \\',
    '      --base-api-url="https://app.example.com/backend-api/" \\',
    '      --login-url="https://app.example.com/auth/login" \\',
    '      --login-flow=token-capture \\',
    '      --login-flow-params=\'{"tokenUrl": "https://app.example.com/api/auth/session",',
    '                            "tokenField": "accessToken"}\'',
  ].join('\n');

  static readonly paramsSchema = TokenCaptureParamsSchema;

  private readonly params: TokenCaptureParams;

  constructor(rawParams: unknown) {
    this.params = parseLoginFlowParams(TokenCaptureLoginFlow, rawParams);
  }

  describe(loginUrl: string): string {
    return (
      `\`latchkey auth browser\` opens ${loginUrl} and stores the '${this.params.tokenField}' ` +
      `field of ${this.params.tokenUrl} as the credentials once it carries a token.`
    );
  }

  createSession(service: Service, appNamePrefix: string): ServiceSession {
    return new TokenCaptureSession(
      service,
      appNamePrefix,
      new URL(this.params.tokenUrl),
      this.params.tokenField.split('.'),
      this.params.header ?? DEFAULT_HEADER_TEMPLATE
    );
  }
}

// TypeScript has no `static implements`, so this is where the class side of the
// flow is checked. The registry checks it again, but the error lands here.
TokenCaptureLoginFlow satisfies LoginFlowClass;
