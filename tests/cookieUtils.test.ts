/**
 * Tests for the RFC 6265 cookie mechanics: reading `Set-Cookie` headers and
 * deciding which URLs the resulting cookies apply to.
 */

import { describe, it, expect } from 'vitest';
import {
  cookieScopeKey,
  doesCookieApplyTo,
  formatCookieHeaderValue,
  parseSetCookieHeader,
} from '../src/cookieUtils.js';

const LOGIN_URL = 'https://example.com/login';

describe('parseSetCookieHeader', () => {
  const responseUrl = new URL('https://app.example.com/account/login');

  it('takes the domain and path from the response when unspecified', () => {
    expect(parseSetCookieHeader('sessionid=abc; HttpOnly; Secure', responseUrl)).toEqual({
      name: 'sessionid',
      value: 'abc',
      domain: 'app.example.com',
      path: '/account',
      isDeletion: false,
    });
  });

  it('honors explicit Domain and Path attributes and strips the leading dot', () => {
    expect(parseSetCookieHeader('sessionid=abc; Domain=.example.com; Path=/', responseUrl)).toEqual(
      {
        name: 'sessionid',
        value: 'abc',
        domain: 'example.com',
        path: '/',
        isDeletion: false,
      }
    );
  });

  it('recognizes deletions', () => {
    const deletions = [
      'sessionid=; Path=/',
      'sessionid=abc; Max-Age=0; Path=/',
      'sessionid=abc; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/',
    ];
    for (const header of deletions) {
      expect(parseSetCookieHeader(header, responseUrl)?.isDeletion).toBe(true);
    }
  });

  it('keeps a future expiry a normal cookie', () => {
    const expires = new Date(Date.now() + 60_000).toUTCString();
    expect(parseSetCookieHeader(`sessionid=abc; Expires=${expires}`, responseUrl)?.isDeletion).toBe(
      false
    );
  });

  it('rejects header values that are not a cookie assignment', () => {
    expect(parseSetCookieHeader('not-a-cookie', responseUrl)).toBeNull();
    expect(parseSetCookieHeader('=orphan-value', responseUrl)).toBeNull();
  });
});

describe('doesCookieApplyTo', () => {
  const cookie = parseSetCookieHeader('a=1; Domain=example.com; Path=/app', new URL(LOGIN_URL))!;

  it('accepts the domain itself and its subdomains', () => {
    expect(doesCookieApplyTo(cookie, new URL('https://example.com/app'))).toBe(true);
    expect(doesCookieApplyTo(cookie, new URL('https://api.example.com/app/x'))).toBe(true);
  });

  it('rejects unrelated hosts and paths outside the cookie path', () => {
    expect(doesCookieApplyTo(cookie, new URL('https://notexample.com/app'))).toBe(false);
    expect(doesCookieApplyTo(cookie, new URL('https://example.com/other'))).toBe(false);
  });
});

describe('cookieScopeKey', () => {
  it('separates cookies of the same name set under different scopes', () => {
    const responseUrl = new URL('https://app.example.com/');
    const hostOnly = parseSetCookieHeader('sessionid=a; Path=/', responseUrl)!;
    const domainWide = parseSetCookieHeader(
      'sessionid=b; Domain=example.com; Path=/',
      responseUrl
    )!;
    const reissued = parseSetCookieHeader('sessionid=c; Path=/', responseUrl)!;

    expect(cookieScopeKey(hostOnly)).not.toBe(cookieScopeKey(domainWide));
    expect(cookieScopeKey(hostOnly)).toBe(cookieScopeKey(reissued));
  });
});

describe('formatCookieHeaderValue', () => {
  it('joins every pair into one header value', () => {
    expect(
      formatCookieHeaderValue([
        { name: 'sessionid', value: 'abc' },
        { name: 'csrftoken', value: 'xyz' },
      ])
    ).toBe('sessionid=abc; csrftoken=xyz');
  });
});
