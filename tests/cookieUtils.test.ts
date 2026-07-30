/**
 * Tests for the RFC 6265 cookie mechanics, exercised through the jar: which
 * cookies a `Set-Cookie` header leaves a browser holding for a given URL.
 */

import { describe, it, expect } from 'vitest';
import { CookieJar, formatCookieHeaderValue } from '../src/cookieUtils.js';

const LOGIN_PAGE = new URL('https://app.example.com/account/login');

/** The cookies a jar for `url` holds after taking in these headers. */
function jarFor(
  url: string,
  setCookieHeaders: readonly string[],
  responseUrl: URL = LOGIN_PAGE
): CookieJar {
  const jar = new CookieJar(new URL(url));
  jar.accept(setCookieHeaders, responseUrl);
  return jar;
}

describe('CookieJar scoping', () => {
  it('keeps a cookie for the host and path that set it', () => {
    const jar = jarFor('https://app.example.com/account/login', ['sessionid=abc']);
    expect(jar.has('sessionid')).toBe(true);
    expect(jar.cookiesNamed(['sessionid'])).toEqual([{ name: 'sessionid', value: 'abc' }]);
  });

  it('defaults a cookie without Path to the directory of the response', () => {
    // Set at /account/login, so it does not apply to the site root.
    expect(jarFor('https://app.example.com/', ['sessionid=abc']).has('sessionid')).toBe(false);
    expect(jarFor('https://app.example.com/account/x', ['sessionid=abc']).has('sessionid')).toBe(
      true
    );
  });

  it('honors an explicit Path', () => {
    expect(jarFor('https://app.example.com/', ['sessionid=abc; Path=/']).has('sessionid')).toBe(
      true
    );
  });

  it('applies a Domain cookie to subdomains, with or without the leading dot', () => {
    for (const domainAttribute of ['Domain=example.com', 'Domain=.example.com']) {
      const header = `sessionid=abc; ${domainAttribute}; Path=/`;
      expect(jarFor('https://api.example.com/', [header]).has('sessionid')).toBe(true);
      expect(jarFor('https://example.com/', [header]).has('sessionid')).toBe(true);
    }
  });

  it('ignores cookies set for an unrelated host', () => {
    const jar = jarFor(
      'https://app.example.com/',
      ['sessionid=abc; Path=/'],
      new URL('https://identity-provider.example.net/sso')
    );
    expect(jar.has('sessionid')).toBe(false);
  });

  it('ignores header values that are not a cookie assignment', () => {
    const jar = jarFor('https://app.example.com/', ['not-a-cookie', '=orphan-value']);
    expect(jar.cookiesNamed(['not-a-cookie', ''])).toEqual([]);
  });
});

describe('CookieJar updates', () => {
  const jarAtRoot = () => new CookieJar(new URL('https://app.example.com/'));

  it('replaces a cookie set again in the same scope', () => {
    const jar = jarAtRoot();
    jar.accept(['sessionid=first; Path=/'], LOGIN_PAGE);
    jar.accept(['sessionid=second; Path=/'], LOGIN_PAGE);
    expect(jar.cookiesNamed(['sessionid'])).toEqual([{ name: 'sessionid', value: 'second' }]);
  });

  it('keeps a cookie of the same name set under a different scope', () => {
    const jar = jarAtRoot();
    jar.accept(
      ['sessionid=host-only; Path=/', 'sessionid=domain-wide; Domain=example.com; Path=/'],
      LOGIN_PAGE
    );
    // A browser would send both.
    expect(jar.cookiesNamed(['sessionid'])).toEqual([
      { name: 'sessionid', value: 'host-only' },
      { name: 'sessionid', value: 'domain-wide' },
    ]);
  });

  it('drops a cookie that is cleared again', () => {
    for (const clearingHeader of [
      'sessionid=; Path=/',
      'sessionid=abc; Max-Age=0; Path=/',
      'sessionid=abc; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/',
    ]) {
      const jar = jarAtRoot();
      jar.accept(['sessionid=abc; Path=/'], LOGIN_PAGE);
      jar.accept([clearingHeader], LOGIN_PAGE);
      expect(jar.has('sessionid')).toBe(false);
    }
  });

  it('keeps a cookie whose expiry is still in the future', () => {
    const expires = new Date(Date.now() + 60_000).toUTCString();
    const jar = jarFor('https://app.example.com/', [`sessionid=abc; Expires=${expires}; Path=/`]);
    expect(jar.has('sessionid')).toBe(true);
  });
});

describe('CookieJar queries', () => {
  it('returns only the names asked for', () => {
    const jar = jarFor('https://app.example.com/', [
      'sessionid=abc; Path=/',
      'csrftoken=xyz; Path=/',
      'analytics=noise; Path=/',
    ]);
    expect(jar.cookiesNamed(['sessionid', 'csrftoken'])).toEqual([
      { name: 'sessionid', value: 'abc' },
      { name: 'csrftoken', value: 'xyz' },
    ]);
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
