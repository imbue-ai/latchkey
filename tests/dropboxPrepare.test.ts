/**
 * Dropbox login creates its OAuth app at login, so the only thing that can be
 * prepared in advance is the redirect URI — a fixed https "bounce" page that
 * forwards the authorization result to latchkey's loopback callback (port
 * carried in `state`). These tests pin that wiring: `prepareFromJson` stores
 * the URI on token-less credentials, and the loopback fallback is used when
 * nothing was prepared.
 */

import { describe, it, expect } from 'vitest';
import { DROPBOX } from '../src/services/dropbox.js';
import { OAuthCredentials } from '../src/apiCredentials/base.js';
import { buildLoopbackRedirectUri, readRedirectUriOverride } from '../src/oauthUtils.js';

describe('Dropbox.prepareFromJson', () => {
  it('stores a prepared redirect URI on token-less OAuth credentials', () => {
    const bounce = 'https://imbue-ai.github.io/oauth-callback';
    const credentials = DROPBOX.prepareFromJson({ redirectUri: bounce });

    expect(credentials).toBeInstanceOf(OAuthCredentials);
    const oauth = credentials as OAuthCredentials;
    // No client id yet — Dropbox creates the app at login.
    expect(oauth.clientId).toBe('');
    expect(oauth.accessToken).toBeUndefined();
    expect(oauth.refreshToken).toBeUndefined();
    expect(oauth.redirectUri).toBe(bounce);
  });

  it('rejects a non-URL redirect URI', () => {
    expect(() => DROPBOX.prepareFromJson({ redirectUri: 'not-a-url' })).toThrow(
      /Invalid prepare input for 'dropbox'/
    );
  });

  it('rejects unknown keys', () => {
    expect(() =>
      DROPBOX.prepareFromJson({ redirectUri: 'https://imbue-ai.github.io/oauth-callback', oops: 1 })
    ).toThrow(/Invalid prepare input for 'dropbox'/);
  });
});

describe('Dropbox redirect-URI override resolution', () => {
  it('reads the prepared override off the credentials', () => {
    const bounce = 'https://imbue-ai.github.io/oauth-callback';
    const prepared = DROPBOX.prepareFromJson({ redirectUri: bounce });

    expect(readRedirectUriOverride(prepared)).toBe(bounce);
  });

  it('falls back to the loopback URI when nothing was prepared', () => {
    expect(readRedirectUriOverride(undefined)).toBeUndefined();
    // The loopback URI is what authorizeApp builds when the override is absent.
    expect(buildLoopbackRedirectUri(54321)).toBe('http://localhost:54321/oauth2callback');
  });
});
