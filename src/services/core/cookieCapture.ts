/**
 * A generic browser login that works for any cookie-authenticated service:
 * open a URL, watch the `Set-Cookie` headers of the responses that follow, and
 * capture named cookies as the credentials. The cookie mechanics themselves
 * live in `cookieUtils`.
 *
 * The flow interprets the registered parameters; the session it creates holds
 * the cookies of one login.
 *
 * Nothing here is service-specific — the cookie names come from whoever
 * registered the service, as the parameters of the `cookie-capture` login flow.
 */

import type { Response } from 'playwright';
import { z } from 'zod';
import { type ApiCredentials, RawCurlCredentials } from '../../apiCredentials/base.js';
import { CookieJar, formatCookieHeaderValue, type CookiePair } from '../../cookieUtils.js';
import {
  parseLoginFlowParams,
  Service,
  SimpleServiceSession,
  type LoginFlow,
  type LoginFlowClass,
  type ServiceSession,
} from './base.js';

export const CookieCaptureParamsSchema = z
  .object({
    /** Cookie names to capture. The login completes once all of them exist. */
    cookieKeys: z.array(z.string().min(1)).min(1),
    /**
     * URL the cookies must apply to. Defaults to the service's login URL, which
     * is right unless sign-in happens on a different host than the API.
     */
    cookieUrl: z.string().url().optional(),
  })
  .strict();

export type CookieCaptureParams = z.infer<typeof CookieCaptureParamsSchema>;

/** Store captured cookies the way `latchkey auth set -H` would. */
export function buildCookieCredentials(cookies: readonly CookiePair[]): ApiCredentials {
  return new RawCurlCredentials(['-H', `Cookie: ${formatCookieHeaderValue(cookies)}`]);
}

function setCookieHeaderValues(headers: readonly { name: string; value: string }[]): string[] {
  return headers
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .map((header) => header.value);
}

/**
 * One run of the flow. A jar remembers the cookies as responses arrive; all
 * this adds is which names the service asked for, and the rule that the login
 * is done once every one of them has turned up.
 */
class CookieCaptureSession extends SimpleServiceSession {
  private readonly jar: CookieJar;
  private readonly cookieKeys: readonly string[];

  constructor(
    service: Service,
    appNamePrefix: string,
    cookieUrl: URL,
    cookieKeys: readonly string[]
  ) {
    super(service, appNamePrefix);
    this.jar = new CookieJar(cookieUrl);
    this.cookieKeys = cookieKeys;
  }

  protected async getApiCredentialsFromResponse(
    response: Response
  ): Promise<ApiCredentials | null> {
    this.jar.accept(setCookieHeaderValues(await response.headersArray()), new URL(response.url()));
    if (!this.cookieKeys.every((cookieKey) => this.jar.has(cookieKey))) {
      return null;
    }
    return buildCookieCredentials(this.jar.cookiesNamed(this.cookieKeys));
  }
}

/**
 * The flow. Its statics are the kind of automation — what `--login-flow`
 * selects — and an instance is that kind configured with one service's
 * parameters, ready to create a session per login.
 */
export class CookieCaptureLoginFlow implements LoginFlow {
  /** Value of `--login-flow`. Not `name`, which every class already has. */
  static readonly flowName = 'cookie-capture';

  static readonly summary = 'Open the login URL and capture named session cookies as they are set.';

  static readonly details = [
    'Parameters:',
    '  cookieKeys  Names of the cookies to capture. Required, at least one. The',
    '              login finishes once every one of them has been set, and they',
    '              are stored together as a single "Cookie: a=1; b=2" header.',
    '  cookieUrl   Full URL, including the scheme, that the cookies must apply',
    '              to. Defaults to the login URL. Set it when signing in happens',
    '              on a different host than the API.',
    '',
    'The cookies are read from the Set-Cookie headers of the responses that',
    'arrive while the user signs in, so a cookie that only a page script sets is',
    'not seen, and neither is one that an already signed-in session never sends',
    'again.',
    '',
    'Example:',
    '  $ latchkey services register my-intranet \\',
    '      --base-api-url="https://intranet.example.com/api/" \\',
    '      --login-url="https://intranet.example.com/login" \\',
    '      --login-flow=cookie-capture \\',
    '      --login-flow-params=\'{"cookieKeys": ["sessionid", "csrftoken"]}\'',
  ].join('\n');

  static readonly paramsSchema = CookieCaptureParamsSchema;

  private readonly params: CookieCaptureParams;

  constructor(rawParams: unknown) {
    this.params = parseLoginFlowParams(CookieCaptureLoginFlow, rawParams);
  }

  describe(loginUrl: string): string {
    const quotedKeys = this.params.cookieKeys.map((cookieKey) => `'${cookieKey}'`).join(', ');
    return (
      `\`latchkey auth browser\` opens ${loginUrl} and stores the ${quotedKeys} ` +
      `cookies of ${this.params.cookieUrl ?? loginUrl} as the credentials once they are set.`
    );
  }

  /**
   * The cookies are looked for wherever they would be sent: the page the login
   * starts from, unless the parameters name somewhere else.
   */
  createSession(service: Service, appNamePrefix: string): ServiceSession {
    return new CookieCaptureSession(
      service,
      appNamePrefix,
      new URL(this.params.cookieUrl ?? service.loginUrl),
      this.params.cookieKeys
    );
  }
}

// TypeScript has no `static implements`, so this is where the class side of the
// flow is checked. The registry checks it again, but the error lands here.
CookieCaptureLoginFlow satisfies LoginFlowClass;
