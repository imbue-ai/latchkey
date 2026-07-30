/**
 * A generic browser login that works for any cookie-authenticated service:
 * open a URL, watch the `Set-Cookie` headers of the responses that follow, and
 * capture named cookies as the credentials.
 *
 * Nothing here is service-specific — the cookie names come from whoever
 * registered the service, as the parameters of the `cookie-capture` login flow.
 */

import type { Response } from 'playwright';
import { z } from 'zod';
import { type ApiCredentials, RawCurlCredentials } from '../../apiCredentials/base.js';
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

/** A captured cookie, reduced to what goes into the header. */
export interface CookiePair {
  readonly name: string;
  readonly value: string;
}

/**
 * Build the credentials for a set of captured cookies.
 *
 * All pairs go into a single `Cookie` header separated by `'; '`, which is the
 * only portable form: RFC 6265 has the user agent send one `Cookie` header,
 * and servers that see several header lines commonly read just the first.
 */
export function buildCookieCredentials(cookies: readonly CookiePair[]): ApiCredentials {
  const header = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  return new RawCurlCredentials(['-H', `Cookie: ${header}`]);
}

/** A `Set-Cookie` header, reduced to what decides whether we want it. */
export interface ParsedSetCookie {
  readonly name: string;
  readonly value: string;
  /** Effective domain, without the leading dot: the `Domain` attribute if
   * present, otherwise the host of the response that set the cookie. */
  readonly domain: string;
  readonly path: string;
  /** Whether the header removes the cookie rather than setting it. */
  readonly isDeletion: boolean;
}

/**
 * The path a cookie without a `Path` attribute applies to: the directory of the
 * request path (RFC 6265 §5.1.4).
 */
function defaultCookiePath(responseUrl: URL): string {
  const path = responseUrl.pathname;
  if (!path.startsWith('/')) {
    return '/';
  }
  const lastSeparatorIndex = path.lastIndexOf('/');
  return lastSeparatorIndex === 0 ? '/' : path.slice(0, lastSeparatorIndex);
}

function isExpired(expiresAttribute: string): boolean {
  const expiresAt = Date.parse(expiresAttribute);
  return !Number.isNaN(expiresAt) && expiresAt <= Date.now();
}

/**
 * Parse one `Set-Cookie` header value. Returns null when it is not a usable
 * cookie definition at all.
 */
export function parseSetCookieHeader(
  headerValue: string,
  responseUrl: URL
): ParsedSetCookie | null {
  const [nameValuePair = '', ...attributeParts] = headerValue.split(';');
  const separatorIndex = nameValuePair.indexOf('=');
  if (separatorIndex <= 0) {
    return null;
  }
  const name = nameValuePair.slice(0, separatorIndex).trim();
  const value = nameValuePair.slice(separatorIndex + 1).trim();

  let domain = responseUrl.hostname.toLowerCase();
  let path = defaultCookiePath(responseUrl);
  // An empty value is how a cookie is cleared without an explicit expiry.
  let isDeletion = value === '';

  for (const attributePart of attributeParts) {
    const attributeSeparatorIndex = attributePart.indexOf('=');
    const attributeName = (
      attributeSeparatorIndex === -1
        ? attributePart
        : attributePart.slice(0, attributeSeparatorIndex)
    )
      .trim()
      .toLowerCase();
    const attributeValue =
      attributeSeparatorIndex === -1 ? '' : attributePart.slice(attributeSeparatorIndex + 1).trim();

    if (attributeName === 'domain' && attributeValue !== '') {
      domain = attributeValue.replace(/^\./, '').toLowerCase();
    } else if (attributeName === 'path' && attributeValue.startsWith('/')) {
      path = attributeValue;
    } else if (attributeName === 'max-age' && Number(attributeValue) <= 0) {
      isDeletion = true;
    } else if (attributeName === 'expires' && isExpired(attributeValue)) {
      isDeletion = true;
    }
  }

  return { name, value, domain, path, isDeletion };
}

/**
 * Whether a browser would send this cookie to the given URL: the URL's host is
 * the cookie's domain or below it, and its path is under the cookie's path.
 */
export function doesCookieApplyTo(cookie: ParsedSetCookie, url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (host !== cookie.domain && !host.endsWith(`.${cookie.domain}`)) {
    return false;
  }
  const path = url.pathname === '' ? '/' : url.pathname;
  return path.startsWith(cookie.path);
}

/**
 * Identity of a cookie in the jar: the same name can be set more than once
 * under different scopes, and a browser then sends all of them.
 */
function cookieScopeKey(cookie: ParsedSetCookie): string {
  return `${cookie.name}\n${cookie.domain}\n${cookie.path}`;
}

export class CookieCaptureServiceSession extends SimpleServiceSession {
  private readonly cookieKeys: readonly string[];
  private readonly cookieUrl: URL;
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

export const COOKIE_CAPTURE_LOGIN_FLOW: LoginFlow<CookieCaptureParams> = {
  name: 'cookie-capture',
  summary:
    'Open the login URL and capture named session cookies as they are set. ' +
    'Parameters: {"cookieKeys": ["<name>", ...], "cookieUrl": "<url>" (optional)}.',
  paramsSchema: CookieCaptureParamsSchema,
  describe: (params, loginUrl) => {
    const quotedKeys = params.cookieKeys.map((cookieKey) => `'${cookieKey}'`).join(', ');
    return (
      `\`latchkey auth browser\` opens ${loginUrl} and stores the ${quotedKeys} ` +
      `cookies of ${params.cookieUrl ?? loginUrl} as the credentials once they are set.`
    );
  },
  createSession: (service, appNamePrefix, params) =>
    new CookieCaptureServiceSession(
      service,
      appNamePrefix,
      new URL(params.cookieUrl ?? service.loginUrl),
      params.cookieKeys
    ),
};
