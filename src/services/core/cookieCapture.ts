/**
 * A generic browser login that works for any cookie-authenticated service:
 * open a URL, let the user sign in there, and capture named cookies as the
 * credentials.
 *
 * Unlike the built-in services, nothing here is service-specific — the URL and
 * the cookie names come from whoever registered the service.
 */

import type { Cookie, Page } from 'playwright';
import { type ApiCredentials, RawCurlCredentials } from '../../apiCredentials/base.js';
import { Service, ServiceSession } from './base.js';

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

export class CookieCaptureServiceSession extends ServiceSession {
  private readonly cookieKeys: readonly string[];
  private readonly cookieUrl: string;
  private capturedCookies: readonly CookiePair[] | null = null;

  constructor(
    service: Service,
    appNamePrefix: string,
    cookieKeys: readonly string[],
    cookieUrl: string
  ) {
    super(service, appNamePrefix);
    this.cookieKeys = cookieKeys;
    this.cookieUrl = cookieUrl;
  }

  /**
   * All cookies carrying one of the requested names, in the order the browser
   * itself would send them.
   *
   * A name can match more than once — the same name can be set both as a
   * host-only cookie and as a domain-wide one — and every match is kept, since
   * that is what the browser would send too.
   */
  private selectRequestedCookies(cookies: readonly Cookie[]): readonly CookiePair[] {
    return cookies
      .filter((cookie) => this.cookieKeys.includes(cookie.name) && cookie.value !== '')
      .map((cookie) => ({ name: cookie.name, value: cookie.value }));
  }

  protected override async checkLoginProgress(page: Page): Promise<void> {
    // Scoped to one URL so a same-named cookie from an unrelated domain
    // (e.g. an identity provider visited on the way) is not mistaken for ours.
    const requestedCookies = this.selectRequestedCookies(
      await page.context().cookies(this.cookieUrl)
    );

    // Cookies can appear one at a time, so the capture only counts once every
    // requested name is present. Taking them from a single poll keeps the
    // stored set internally consistent.
    const everyKeyPresent = this.cookieKeys.every((cookieKey) =>
      requestedCookies.some((cookie) => cookie.name === cookieKey)
    );
    if (everyKeyPresent) {
      this.capturedCookies = requestedCookies;
    }
  }

  onResponse(): void {
    // The cookies are read from browser state instead, since they can also be
    // set by page scripts rather than by a response.
  }

  protected isLoginComplete(): boolean {
    return this.capturedCookies !== null;
  }

  protected finalizeCredentials(): Promise<ApiCredentials | null> {
    if (this.capturedCookies === null) {
      return Promise.resolve(null);
    }
    return Promise.resolve(buildCookieCredentials(this.capturedCookies));
  }
}
