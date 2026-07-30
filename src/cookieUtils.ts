/**
 * HTTP cookie mechanics, following RFC 6265: a jar that takes in `Set-Cookie`
 * headers and answers which cookies a browser would send back.
 *
 * Nothing here knows about latchkey's services or credentials. The browser
 * itself does all of this internally, and Playwright exposes the result via
 * `context.cookies(url)`; this module exists for the cases where the headers
 * are read directly from responses rather than from the browser's cookie jar.
 */

/** A cookie reduced to what goes into a `Cookie` header. */
export interface CookiePair {
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
export class CookieJar {
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
export function formatCookieHeaderValue(cookies: readonly CookiePair[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}
