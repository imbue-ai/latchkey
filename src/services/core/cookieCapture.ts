/**
 * A generic browser login that works for any cookie-authenticated service:
 * open a URL, watch the `Set-Cookie` headers of the responses that follow, and
 * capture named cookies as the credentials. The cookie mechanics themselves
 * live in `cookieUtils`.
 *
 * The flow interprets the registered parameters; the capture it creates holds
 * the cookies of one login.
 *
 * Nothing here is service-specific — the cookie names come from whoever
 * registered the service, as the parameters of the `cookie-capture` login flow.
 */

import type { Response } from 'playwright';
import { z } from 'zod';
import { type ApiCredentials, RawCurlCredentials } from '../../apiCredentials/base.js';
import { CookieJar, formatCookieHeaderValue, type CookiePair } from '../../cookieUtils.js';
import { Service, SimpleServiceSession, type ServiceSession } from './base.js';
import type { LoginFlow } from './loginFlows.js';

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

/**
 * The cookies accumulated during one login, and the decision of when enough of
 * them have been seen. A jar does the remembering; this only knows which names
 * the service asked for.
 *
 * Separate from the session so that the behaviour can be exercised with header
 * strings instead of a browser, leaving the session a few lines of glue.
 */
export class CookieCapture {
  private readonly jar: CookieJar;
  private readonly cookieKeys: readonly string[];

  constructor(cookieUrl: URL, cookieKeys: readonly string[]) {
    this.jar = new CookieJar(cookieUrl);
    this.cookieKeys = cookieKeys;
  }

  /**
   * Take in the `Set-Cookie` headers of one response, returning the credentials
   * once every requested cookie is present and null until then: cookies
   * typically arrive across several responses.
   */
  accept(setCookieHeaderValues: readonly string[], responseUrl: URL): ApiCredentials | null {
    this.jar.accept(setCookieHeaderValues, responseUrl);
    if (!this.cookieKeys.every((cookieKey) => this.jar.has(cookieKey))) {
      return null;
    }
    return buildCookieCredentials(this.jar.cookiesNamed(this.cookieKeys));
  }
}

function setCookieHeaderValues(headers: readonly { name: string; value: string }[]): string[] {
  return headers
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .map((header) => header.value);
}

/**
 * One run of the flow. Everything it knows how to do is read `Set-Cookie` off a
 * response and pass it to the capture, so it is not exported: the capture is
 * what there is to test.
 */
class CookieCaptureSession extends SimpleServiceSession {
  private readonly capture: CookieCapture;

  constructor(service: Service, appNamePrefix: string, capture: CookieCapture) {
    super(service, appNamePrefix);
    this.capture = capture;
  }

  protected async getApiCredentialsFromResponse(
    response: Response
  ): Promise<ApiCredentials | null> {
    return this.capture.accept(
      setCookieHeaderValues(await response.headersArray()),
      new URL(response.url())
    );
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

  constructor(params: CookieCaptureParams) {
    this.params = params;
  }

  describe(loginUrl: string): string {
    const quotedKeys = this.params.cookieKeys.map((cookieKey) => `'${cookieKey}'`).join(', ');
    return (
      `\`latchkey auth browser\` opens ${loginUrl} and stores the ${quotedKeys} ` +
      `cookies of ${this.params.cookieUrl ?? loginUrl} as the credentials once they are set.`
    );
  }

  /**
   * The capture this flow performs, given the page the login starts from. The
   * cookies are looked for wherever they would be sent, which is that page
   * unless the parameters name somewhere else.
   */
  createCapture(loginUrl: string): CookieCapture {
    return new CookieCapture(new URL(this.params.cookieUrl ?? loginUrl), this.params.cookieKeys);
  }

  createSession(service: Service, appNamePrefix: string): ServiceSession {
    return new CookieCaptureSession(service, appNamePrefix, this.createCapture(service.loginUrl));
  }
}
