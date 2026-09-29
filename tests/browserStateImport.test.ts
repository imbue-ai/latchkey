import { describe, expect, it } from 'vitest';
import {
  InvalidBrowserStateError,
  mergeBrowserStorageStates,
  parseBrowserStorageState,
  type BrowserStorageState,
} from '../src/browserStateImport.js';

function cookie(
  name: string,
  domain: string,
  value: string
): BrowserStorageState['cookies'][number] {
  return {
    name,
    value,
    domain,
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  };
}

describe('mergeBrowserStorageStates', () => {
  it('keeps cookies from both states and prefers imported ones', () => {
    const existing: BrowserStorageState = {
      cookies: [cookie('session', 'example.com', 'old'), cookie('other', 'example.com', 'kept')],
      origins: [{ origin: 'https://example.com', localStorage: [{ name: 'a', value: 'old' }] }],
    };
    const imported: BrowserStorageState = {
      cookies: [cookie('session', 'example.com', 'new'), cookie('session', 'example.org', 'x')],
      origins: [{ origin: 'https://example.com', localStorage: [{ name: 'a', value: 'new' }] }],
    };

    const merged = mergeBrowserStorageStates(existing, imported);

    expect(merged.cookies).toEqual([
      cookie('session', 'example.com', 'new'),
      cookie('other', 'example.com', 'kept'),
      cookie('session', 'example.org', 'x'),
    ]);
    expect(merged.origins).toEqual([
      { origin: 'https://example.com', localStorage: [{ name: 'a', value: 'new' }] },
    ]);
  });
});

describe('parseBrowserStorageState', () => {
  it('parses a stored state', () => {
    const state: BrowserStorageState = {
      cookies: [cookie('session', 'example.com', 'value')],
      origins: [],
    };
    expect(parseBrowserStorageState(JSON.stringify(state))).toEqual(state);
  });

  it('fills in missing sections', () => {
    expect(parseBrowserStorageState('{}')).toEqual({ cookies: [], origins: [] });
  });

  it('rejects invalid JSON', () => {
    expect(() => parseBrowserStorageState('not json')).toThrow(InvalidBrowserStateError);
  });
});
