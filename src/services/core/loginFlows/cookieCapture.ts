/**
 * A generic browser login that works for any cookie-authenticated service:
 * open a URL, watch the `Set-Cookie` headers of the responses that follow, and
 * capture named cookies as the credentials.
 *
 * The cookie mechanics — reading `Set-Cookie`, deciding where a cookie applies,
 * writing a `Cookie` header — are RFC 6265 and not specific to this flow, but
 * they stay private to it: nothing else needs them, and behind the LoginFlow
 * interface nobody has to care how this flow works. If cookie handling is ever
 * wanted elsewhere, this is the part to lift back out into a module of its own.
 *
 * The flow interprets the registered parameters; the session it creates holds
 * the cookies of one login.
 *
 * Nothing here is service-specific — the cookie names come from whoever
 * registered the service, as the parameters of the `cookie-capture` login flow.
 */

import type { Response } from 'playwright';
import { z } from 'zod';
import { type ApiCredentials, RawCurlCredentials } from '../../../apiCredentials/base.js';
import { Service, SimpleServiceSession, type ServiceSession } from '../base.js';
import { parseLoginFlowParams, type LoginFlow, type LoginFlowClass } from './base.js';

/** A cookie reduced to what goes into a `Cookie` header. */
interface CookiePair {
  readonly name: string;
  readonly value: string;
}

/** A `Set-Cookie` header, reduced to what decides where a cookie applies. */
interface ParsedSetCookie {
  readonly name: string;
  readonly value: string;
  /**
   * Effective domain, without the leading dot: the `Domain` attribute if
   * present, otherwise the host of the response that set the cookie.
   */
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
 * Parse one `Set-Cookie` header value, as sent by the response at
 * `responseUrl`. Returns null when it is not a usable cookie definition at all.
 */
function parseSetCookieHeader(headerValue: string, responseUrl: URL): ParsedSetCookie | null {
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
function doesCookieApplyTo(cookie: ParsedSetCookie, url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (host !== cookie.domain && !host.endsWith(`.${cookie.domain}`)) {
    return false;
  }
  const path = url.pathname === '' ? '/' : url.pathname;
  return path.startsWith(cookie.path);
}

/**
 * Identity of a cookie in the jar. The same name can be set more than once
 * under different scopes, and a browser then sends all of them, so a cookie is
 * only superseded by one of matching name, domain and path.
 */
function cookieScopeKey(cookie: ParsedSetCookie): string {
  return `${cookie.name}\n${cookie.domain}\n${cookie.path}`;
}

/**
 * The cookies that would be sent to one URL, built up from the `Set-Cookie`
 * headers of the responses observed so far.
 *
 * Only cookies that apply to the jar's URL are kept, so cookies picked up along
 * the way — from an identity provider on another domain, say — are discarded as
 * they arrive.
 */
class CookieJar {
  private readonly url: URL;
  private readonly cookiesByScope = new Map<string, ParsedSetCookie>();

  constructor(url: URL) {
    this.url = url;
  }

  /**
   * Take in the `Set-Cookie` headers of one response: cookies it sets are
   * recorded, and cookies it clears are dropped.
   */
  accept(setCookieHeaderValues: readonly string[], responseUrl: URL): void {
    for (const headerValue of setCookieHeaderValues) {
      const cookie = parseSetCookieHeader(headerValue, responseUrl);
      if (cookie === null || !doesCookieApplyTo(cookie, this.url)) {
        continue;
      }
      if (cookie.isDeletion) {
        this.cookiesByScope.delete(cookieScopeKey(cookie));
      } else {
        this.cookiesByScope.set(cookieScopeKey(cookie), cookie);
      }
    }
  }

  has(name: string): boolean {
    return [...this.cookiesByScope.values()].some((cookie) => cookie.name === name);
  }

  /**
   * The cookies of the given names. A name can appear more than once — set both
   * host-only and domain-wide, say — and a browser sends every one of them.
   */
  cookiesNamed(names: readonly string[]): readonly CookiePair[] {
    return [...this.cookiesByScope.values()]
      .filter((cookie) => names.includes(cookie.name))
      .map((cookie) => ({ name: cookie.name, value: cookie.value }));
  }
}

/**
 * Render cookies as the value of a single `Cookie` header.
 *
 * One header carrying every pair separated by `'; '` is the only portable
 * form: RFC 6265 has the user agent send one `Cookie` header, and servers that
 * see several header lines commonly read just the first.
 */
function formatCookieHeaderValue(cookies: readonly CookiePair[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

const CookieCaptureParamsSchema = z
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

type CookieCaptureParams = z.infer<typeof CookieCaptureParamsSchema>;

/** Store captured cookies the way `latchkey auth set -H` would. */
function buildCookieCredentials(cookies: readonly CookiePair[]): ApiCredentials {
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
