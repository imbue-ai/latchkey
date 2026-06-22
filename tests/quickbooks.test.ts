import { describe, it, expect } from 'vitest';
import { QUICKBOOKS, QuickBooksCredentials } from '../src/services/quickbooks.js';
import { ApiCredentialsUsageError } from '../src/apiCredentials/base.js';

describe('QuickBooks credentials', () => {
  it('starts unauthorized with just a client id/secret and no tokens', () => {
    const credentials = QUICKBOOKS.getCredentialsNoCurl(['my-client-id', 'my-secret']);
    expect(credentials).toBeInstanceOf(QuickBooksCredentials);

    const quickbooks = credentials as QuickBooksCredentials;
    expect(quickbooks.clientId).toBe('my-client-id');
    expect(quickbooks.clientSecret).toBe('my-secret');
    expect(quickbooks.accessToken).toBeUndefined();
    expect(quickbooks.refreshToken).toBeUndefined();
    expect(quickbooks.realmId).toBeUndefined();
    // Without an access token the credentials need an interactive login, not a
    // token refresh, so they must not report "expired".
    expect(quickbooks.isExpired()).toBeUndefined();
  });

  it('refuses to sign requests before authorization', () => {
    const quickbooks = new QuickBooksCredentials('id', 'secret');
    expect(() => quickbooks.injectIntoCurlCall(['https://quickbooks.api.intuit.com/'])).toThrow(
      ApiCredentialsUsageError
    );
  });

  it('round-trips through JSON', () => {
    const quickbooks = new QuickBooksCredentials(
      'id',
      'secret',
      'access',
      'refresh',
      'realm-1',
      '2030-01-01T00:00:00.000Z'
    );
    const restored = QuickBooksCredentials.fromJSON(quickbooks.toJSON());
    expect(restored.toJSON()).toEqual(quickbooks.toJSON());
  });
});

describe('QuickBooks browser-prepare flow', () => {
  it('exposes an automatic prepare() step on its session', () => {
    const session = QUICKBOOKS.getSession('Latchkey');
    expect(typeof session.prepare).toBe('function');
  });

  it('documents the browser-prepare -> browser flow and a localhost (non-https) redirect URI', () => {
    expect(QUICKBOOKS.info).toMatch(/auth browser-prepare quickbooks/);
    expect(QUICKBOOKS.info).toMatch(/auth browser quickbooks/);
    expect(QUICKBOOKS.info).toContain('http://localhost:8765/callback');
    // The redirect URI must stay http://localhost (Intuit allows it for local
    // development); it must never be promoted to https://localhost.
    expect(QUICKBOOKS.info).not.toContain('https://localhost');
  });
});
