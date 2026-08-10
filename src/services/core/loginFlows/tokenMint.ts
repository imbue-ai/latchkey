/**
 * A generic browser login for services that issue a long-lived API token from a
 * short-lived signed-in session: open a login URL, wait for the session cookie
 * to be set, then exchange that session for a durable token by calling the
 * service's own "create token" endpoint, and store the token as a bearer header.
 *
 * This is the counterpart to `cookie-capture`. Cookie-capture stores the
 * session cookie itself, which is simplest but expires with the session;
 * token-mint spends the session once to obtain a token that outlives it (the
 * common "personal access token" / "API key" pattern: Linear, ngrok, OpenHost,
 * and many self-hosted apps). Everything is parameterised, so a registered
 * service selects it by name and supplies the endpoint details as JSON.
 *
 * The mint request is an ordinary curl call carrying the freshly-established
 * session cookie plus a same-origin `Origin` header (so it passes both
 * cookie-auth and any CSRF origin check), rather than a browser fetch. That
 * keeps the network step out of the browser and makes it directly testable.
 *
 * Nothing here is service-specific -- the cookie name, endpoint, request body
 * and where the token sits in the response all come from whoever registered the
 * service, as the parameters of the `token-mint` login flow.
 */

import type { Browser, BrowserContext, Response } from 'playwright';
import { z } from 'zod';
import { type ApiCredentials, RawCurlCredentials } from '../../../apiCredentials/base.js';
import { runCapturedAsync } from '../../../curl.js';
import { LoginFailedError, Service, ServiceSession } from '../base.js';
import { parseLoginFlowParams, type LoginFlow, type LoginFlowClass } from './base.js';

// Defaults for the optional parameters. They live in code rather than as zod
// `.default()`s so the schema's input and output types stay identical, which is
// what lets `parseLoginFlowParams`'s single-type `ZodType<Params>` wrapper infer
// them (the same reason cookie-capture's schema carries no defaults).
const DEFAULT_MINT_METHOD = 'POST';
const DEFAULT_TOKEN_FIELD = 'token';
const DEFAULT_HEADER = 'Authorization';
const DEFAULT_VALUE_PREFIX = 'Bearer ';

const TokenMintParamsSchema = z
  .object({
    /**
     * Name of the cookie the sign-in sets. The login is complete once it
     * appears, and it is what authenticates the mint request.
     */
    sessionCookie: z.string().min(1),
    /** Full URL of the endpoint that mints the token, e.g. the create-token API. */
    mintUrl: z.string().url(),
    /** HTTP method the mint endpoint expects. Almost always POST. */
    mintMethod: z.enum(['POST', 'PUT', 'PATCH']).optional(),
    /** JSON body sent to the mint endpoint (e.g. an expiry choice). */
    mintBody: z.record(z.string(), z.unknown()).optional(),
    /**
     * When set, a generated, recognizable name is written to this field of the
     * body, so the user can find and revoke the token later.
     */
    nameField: z.string().min(1).optional(),
    /**
     * Dot-path to the token in the JSON response, e.g. `token` or `data.token`.
     */
    tokenField: z.string().min(1).optional(),
    /** Header the token is stored under. */
    header: z.string().min(1).optional(),
    /** Text prepended to the token in that header. */
    valuePrefix: z.string().optional(),
  })
  .strict();

type TokenMintParams = z.infer<typeof TokenMintParamsSchema>;

/**
 * Read a dot-path (`a.b.c`) out of a parsed JSON value, returning the string at
 * the end of it or null if the path is missing or does not end at a string.
 */
export function readTokenField(body: unknown, path: string): string | null {
  let current: unknown = body;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null || !(key in current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' && current !== '' ? current : null;
}

/**
 * Parse a `Set-Cookie` header enough to tell whether it assigns a non-empty
 * value to `name`. Full RFC 6265 handling is cookie-capture's job; the mint
 * flow only needs the "has the session cookie been set yet" signal.
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
 * Exchange an established session for a durable token: POST the mint endpoint
 * with the session's cookies (plus a same-origin Origin header) and read the
 * token out of the response, returning it as a stored bearer-style credential.
 *
 * Separated from the session so the network step is testable on its own, with
 * the async subprocess runner swapped out. `appName` is the recognizable label
 * written to `nameField` when one is configured; it is ignored otherwise.
 */
export async function mintTokenCredentials(
  params: TokenMintParams,
  cookieHeader: string,
  appName: string
): Promise<ApiCredentials> {
  const body: Record<string, unknown> = { ...params.mintBody };
  if (params.nameField !== undefined) {
    body[params.nameField] = appName;
  }

  const origin = new URL(params.mintUrl).origin;
  const result = await runCapturedAsync([
    '-sS',
    '-X',
    params.mintMethod ?? DEFAULT_MINT_METHOD,
    params.mintUrl,
    '-H',
    'Content-Type: application/json',
    '-H',
    `Cookie: ${cookieHeader}`,
    // A same-origin Origin satisfies servers that reject cross-site writes.
    '-H',
    `Origin: ${origin}`,
    '--data',
    JSON.stringify(body),
  ]);
  if (result.returncode !== 0) {
    throw new LoginFailedError(`Minting an API token failed: ${result.stderr.trim()}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new LoginFailedError('The mint endpoint did not return JSON.');
  }
  const tokenField = params.tokenField ?? DEFAULT_TOKEN_FIELD;
  const token = readTokenField(parsed, tokenField);
  if (token === null) {
    throw new LoginFailedError(`No token found at '${tokenField}' in the mint response.`);
  }

  const header = params.header ?? DEFAULT_HEADER;
  const valuePrefix = params.valuePrefix ?? DEFAULT_VALUE_PREFIX;
  return new RawCurlCredentials(['-H', `${header}: ${valuePrefix}${token}`]);
}

/**
 * One run of the flow. The login phase waits for the session cookie; finalizing
 * spends that session on a single mint call and keeps the token it returns.
 */
class TokenMintSession extends ServiceSession {
  private isLoggedIn = false;

  constructor(
    service: Service,
    appNamePrefix: string,
    private readonly params: TokenMintParams
  ) {
    super(service, appNamePrefix);
  }

  async onResponse(response: Response): Promise<void> {
    if (this.isLoggedIn) {
      return;
    }
    for (const header of await response.headersArray()) {
      if (
        header.name.toLowerCase() === 'set-cookie' &&
        setsCookie(header.value, this.params.sessionCookie)
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
    // Send exactly what the browser would send to the mint URL -- the session
    // cookie the sign-in set, plus any others (a CSRF cookie, say) scoped to it.
    const cookies = await context.cookies(this.params.mintUrl);
    if (cookies.length === 0) {
      throw new LoginFailedError('No session cookies were available to mint an API token.');
    }
    const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    return mintTokenCredentials(this.params, cookieHeader, this.generateAppName());
  }
}

/**
 * The flow. Its statics are the kind of automation -- what `--login-flow`
 * selects -- and an instance is that kind configured with one service's
 * parameters, ready to create a session per login.
 */
export class TokenMintLoginFlow implements LoginFlow {
  static readonly flowName = 'token-mint';

  static readonly summary =
    'Sign in, then exchange the session for a long-lived API token via a mint endpoint.';

  static readonly details = [
    'Parameters:',
    '  sessionCookie  Name of the cookie the sign-in sets. Required. The login',
    '                 finishes once it appears, and it authenticates the mint call.',
    '  mintUrl        Full URL of the endpoint that creates the token. Required.',
    '  mintMethod     HTTP method for the mint call. Default POST (or PUT/PATCH).',
    '  mintBody       JSON object sent as the mint request body. Default {}.',
    '  nameField      If set, a generated recognizable name is written to this',
    '                 field of the body so the user can find and revoke the token.',
    '  tokenField     Dot-path to the token in the JSON response. Default "token".',
    '  header         Header the token is stored under. Default "Authorization".',
    '  valuePrefix    Text prepended to the token. Default "Bearer ".',
    '',
    'The mint call carries the cookies the browser holds for mintUrl plus a',
    'same-origin Origin header, so it passes cookie-auth and CSRF origin checks.',
    '',
    'Example (a self-hosted OpenHost instance):',
    '  $ latchkey services register my-openhost \\',
    '      --base-api-url="https://oh.example.com/api/" \\',
    '      --login-url="https://oh.example.com/login" \\',
    '      --login-flow=token-mint \\',
    '      --login-flow-params=\'{"sessionCookie": "session_token",',
    '        "mintUrl": "https://oh.example.com/api/tokens",',
    '        "mintBody": {"expiry_hours": "never"}, "nameField": "name"}\'',
  ].join('\n');

  static readonly paramsSchema = TokenMintParamsSchema;

  private readonly params: TokenMintParams;

  constructor(rawParams: unknown) {
    this.params = parseLoginFlowParams(TokenMintLoginFlow, rawParams);
  }

  describe(loginUrl: string): string {
    return (
      `\`latchkey auth browser\` opens ${loginUrl}, waits for the ` +
      `'${this.params.sessionCookie}' cookie, then mints a token at ` +
      `${this.params.mintUrl} and stores it as the ` +
      `'${this.params.header ?? DEFAULT_HEADER}' header.`
    );
  }

  createSession(service: Service, appNamePrefix: string): ServiceSession {
    return new TokenMintSession(service, appNamePrefix, this.params);
  }
}

// TypeScript has no `static implements`, so this is where the class side of the
// flow is checked. The registry checks it again, but the error lands here.
TokenMintLoginFlow satisfies LoginFlowClass;
