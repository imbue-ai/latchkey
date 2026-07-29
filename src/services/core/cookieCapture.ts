/**
 * A generic browser login that works for any cookie-authenticated service:
 * open a URL, let the user sign in there, and capture a single named cookie
 * as the credentials.
 *
 * Unlike the built-in services, nothing here is service-specific — the URL and
 * the cookie name come from whoever registered the service.
 */

import type { Page } from 'playwright';
import { type ApiCredentials, RawCurlCredentials } from '../../apiCredentials/base.js';
import { Service, ServiceSession } from './base.js';

export function buildCookieCredentials(cookieKey: string, cookieValue: string): ApiCredentials {
  return new RawCurlCredentials(['-H', `Cookie: ${cookieKey}=${cookieValue}`]);
}

export class CookieCaptureServiceSession extends ServiceSession {
  private readonly cookieKey: string;
  private readonly cookieUrl: string;
  private capturedCookieValue: string | null = null;

  constructor(service: Service, appNamePrefix: string, cookieKey: string, cookieUrl: string) {
    super(service, appNamePrefix);
    this.cookieKey = cookieKey;
    this.cookieUrl = cookieUrl;
  }

  onResponse(): void {
    // The cookie is read from browser state instead, since it can also be set
    // by page scripts rather than by a response.
  }

  protected override async checkLoginProgress(page: Page): Promise<void> {
    // Scoped to one URL so a same-named cookie from an unrelated domain
    // (e.g. an identity provider visited on the way) is not mistaken for ours.
    const cookies = await page.context().cookies(this.cookieUrl);
    const capturedCookie = cookies.find(
      (cookie) => cookie.name === this.cookieKey && cookie.value !== ''
    );
    if (capturedCookie !== undefined) {
      this.capturedCookieValue = capturedCookie.value;
    }
  }

  protected isLoginComplete(): boolean {
    return this.capturedCookieValue !== null;
  }

  protected finalizeCredentials(): Promise<ApiCredentials | null> {
    if (this.capturedCookieValue === null) {
      return Promise.resolve(null);
    }
    return Promise.resolve(buildCookieCredentials(this.cookieKey, this.capturedCookieValue));
  }
}
