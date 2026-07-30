/**
 * A generic browser login that works for any cookie-authenticated service:
 * open a URL, watch the `Set-Cookie` headers of the responses that follow, and
 * capture named cookies as the credentials. The cookie mechanics themselves
 * live in `cookieUtils`.
 *
 * The flow interprets the registered parameters; the session it creates carries
 * out one login.
 *
 * Nothing here is service-specific — the cookie names come from whoever
 * registered the service, as the parameters of the `cookie-capture` login flow.
 */

import type { Response } from 'playwright';
import { z } from 'zod';
import { type ApiCredentials, RawCurlCredentials } from '../../apiCredentials/base.js';
import {
  cookieScopeKey,
  doesCookieApplyTo,
  formatCookieHeaderValue,
  parseSetCookieHeader,
  type CookiePair,
  type ParsedSetCookie,
} from '../../cookieUtils.js';
import { Service, SimpleServiceSession } from './base.js';
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
 * One run of the flow: it watches the responses of a single login and
 * accumulates the cookies it was asked for. The flow above interprets the
 * parameters; this only deals in concrete names and a URL.
 */
export class CookieCaptureSession extends SimpleServiceSession {
  private readonly cookieUrl: URL;
  private readonly cookieKeys: readonly string[];
  private readonly capturedCookies = new Map<string, ParsedSetCookie>();

  constructor(
    service: Service,
    appNamePrefix: string,
    cookieUrl: URL,
    cookieKeys: readonly string[]
  ) {
    super(service, appNamePrefix);
    this.cookieUrl = cookieUrl;
    this.cookieKeys = cookieKeys;
  }

  /**
   * Record every requested cookie set by this response, and drop the ones it
   * clears. Cookies typically arrive across several responses, so credentials
   * are only produced once each requested name is present.
   */
  protected async getApiCredentialsFromResponse(
    response: Response
  ): Promise<ApiCredentials | null> {
    const responseUrl = new URL(response.url());
    for (const header of await response.headersArray()) {
      if (header.name.toLowerCase() !== 'set-cookie') {
        continue;
      }
      const cookie = parseSetCookieHeader(header.value, responseUrl);
      if (
        cookie === null ||
        !this.cookieKeys.includes(cookie.name) ||
        !doesCookieApplyTo(cookie, this.cookieUrl)
      ) {
        continue;
      }
      if (cookie.isDeletion) {
        this.capturedCookies.delete(cookieScopeKey(cookie));
      } else {
        this.capturedCookies.set(cookieScopeKey(cookie), cookie);
      }
    }

    const captured = [...this.capturedCookies.values()];
    const everyKeyPresent = this.cookieKeys.every((cookieKey) =>
      captured.some((cookie) => cookie.name === cookieKey)
    );
    if (!everyKeyPresent) {
      return null;
    }
    return buildCookieCredentials(captured);
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

  static readonly summary =
    'Open the login URL and capture named session cookies as they are set. ' +
    'Parameters: {"cookieKeys": ["<name>", ...], "cookieUrl": "<url>" (optional)}.';

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

  /** The cookies are looked for wherever they would be sent, defaulting to the login page. */
  createSession(service: Service, appNamePrefix: string): CookieCaptureSession {
    return new CookieCaptureSession(
      service,
      appNamePrefix,
      new URL(this.params.cookieUrl ?? service.loginUrl),
      this.params.cookieKeys
    );
  }
}
