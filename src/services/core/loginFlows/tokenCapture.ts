/**
 * A generic browser login for services whose credential is a token the web app
 * mints for itself: open a URL, watch the responses that arrive while the user
 * signs in, and lift a token out of the JSON body of a named endpoint.
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

import type { Response } from 'playwright';
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

/** Store the captured token the way `latchkey auth set -H` would. */
function buildTokenCredentials(headerTemplate: string, token: string): ApiCredentials {
  return new RawCurlCredentials(['-H', headerTemplate.replaceAll(TOKEN_PLACEHOLDER, token)]);
}

/**
 * One run of the flow: responses go by, and the first one from the mint
 * endpoint that carries a token ends the login.
 */
class TokenCaptureSession extends SimpleServiceSession {
  private readonly tokenEndpointIdentity: string;
  private readonly tokenPath: readonly string[];
  private readonly headerTemplate: string;

  constructor(
    service: Service,
    appNamePrefix: string,
    tokenUrl: URL,
    tokenPath: readonly string[],
    headerTemplate: string
  ) {
    super(service, appNamePrefix);
    this.tokenEndpointIdentity = endpointIdentity(tokenUrl);
    this.tokenPath = tokenPath;
    this.headerTemplate = headerTemplate;
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

    let token: string | null;
    try {
      token = readTokenAtPath(JSON.parse(await response.text()), this.tokenPath);
    } catch {
      // Unreadable or not JSON: the endpoint answered with something this
      // registration does not describe. Keep waiting rather than fail the
      // login — the response that carries the token may still be coming.
      return null;
    }

    return token === null ? null : buildTokenCredentials(this.headerTemplate, token);
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
    'The login finishes when that endpoint answers with a non-empty token, not',
    'when it is merely requested: a signed-out visitor commonly gets the same',
    'endpoint answering `{}`. A token minted this way expires and cannot be',
    'refreshed — the refresh material stays in the browser — so expect to sign',
    'in again periodically.',
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
