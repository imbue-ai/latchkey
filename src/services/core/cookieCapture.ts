/**
 * A generic browser login that works for any cookie-authenticated service:
 * open a URL, watch the `Set-Cookie` headers of the responses that follow, and
 * capture named cookies as the credentials. The cookie mechanics themselves
 * live in `cookieUtils`.
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
 * The login flow itself. The class is its own definition: `flowName`,
 * `summary`, `paramsSchema` and `describe` are the static side that
 * `defineLoginFlow` registers, and instances are the sessions it creates.
 */
export class CookieCaptureServiceSession extends SimpleServiceSession {
  /** Value of `--login-flow`. Not `name`, which every class already has. */
  static readonly flowName = 'cookie-capture';

  static readonly summary =
    'Open the login URL and capture named session cookies as they are set. ' +
    'Parameters: {"cookieKeys": ["<name>", ...], "cookieUrl": "<url>" (optional)}.';

  static readonly paramsSchema = CookieCaptureParamsSchema;

  static describe(params: CookieCaptureParams, loginUrl: string): string {
    const quotedKeys = params.cookieKeys.map((cookieKey) => `'${cookieKey}'`).join(', ');
    return (
      `\`latchkey auth browser\` opens ${loginUrl} and stores the ${quotedKeys} ` +
      `cookies of ${params.cookieUrl ?? loginUrl} as the credentials once they are set.`
    );
  }

  private readonly cookieKeys: readonly string[];
  private readonly cookieUrl: URL;
  private readonly capturedCookies = new Map<string, ParsedSetCookie>();

  constructor(service: Service, appNamePrefix: string, params: CookieCaptureParams) {
    super(service, appNamePrefix);
    this.cookieKeys = params.cookieKeys;
    this.cookieUrl = new URL(params.cookieUrl ?? service.loginUrl);
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
