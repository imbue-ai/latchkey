import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectLoginOrigins,
  InvalidBrowserStateError,
  measureCopiedUserDataSizeInBytes,
  mergeBrowserStorageStates,
  parseBrowserStorageState,
  type BrowserStorageState,
} from '../src/browserStateImport.js';
import type { Service } from '../src/services/index.js';

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

describe('collectLoginOrigins', () => {
  it('returns the distinct web origins of the login URLs', () => {
    const services = [
      { loginUrl: 'https://example.com/login' },
      { loginUrl: 'https://example.com/other' },
      { loginUrl: 'http://localhost:8080/sign-in' },
      { loginUrl: '' },
      { loginUrl: 'mailto:someone@example.com' },
    ] as unknown as Service[];

    expect(collectLoginOrigins(services)).toEqual(['http://localhost:8080', 'https://example.com']);
  });
});

describe('measureCopiedUserDataSizeInBytes', () => {
  it('counts only the copied paths', () => {
    const userDataDirectory = mkdtempSync(join(tmpdir(), 'latchkey-chrome-user-data-test-'));
    try {
      mkdirSync(join(userDataDirectory, 'Default', 'Network'), { recursive: true });
      mkdirSync(join(userDataDirectory, 'Default', 'Local Storage', 'leveldb'), {
        recursive: true,
      });
      mkdirSync(join(userDataDirectory, 'Default', 'Cache'), { recursive: true });
      mkdirSync(join(userDataDirectory, 'OptGuideOnDeviceModel'), { recursive: true });
      writeFileSync(join(userDataDirectory, 'Local State'), 'a'.repeat(10));
      writeFileSync(join(userDataDirectory, 'Default', 'Network', 'Cookies'), 'b'.repeat(20));
      writeFileSync(
        join(userDataDirectory, 'Default', 'Local Storage', 'leveldb', '000003.log'),
        'c'.repeat(30)
      );
      writeFileSync(join(userDataDirectory, 'Default', 'Cache', 'data_0'), 'd'.repeat(1000));
      writeFileSync(join(userDataDirectory, 'OptGuideOnDeviceModel', 'model'), 'e'.repeat(1000));

      expect(measureCopiedUserDataSizeInBytes(userDataDirectory)).toBe(60);
    } finally {
      rmSync(userDataDirectory, { recursive: true, force: true });
    }
  });
});
