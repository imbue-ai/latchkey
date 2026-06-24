/**
 * Tests for Ramp's browser-login (OAuth PKCE) session and the credential
 * handling that supports it.
 *
 * These are intentionally network-free: they only exercise the synchronous
 * branches (no token mint, no refresh HTTP call, no browser). The live OAuth
 * authorization-code + PKCE flow against Ramp's servers is validated manually.
 */

import { describe, it, expect } from 'vitest';
import { RAMP, RampCredentials } from '../src/services/ramp.js';
import { AuthorizationBearer, OAuthCredentials } from '../src/apiCredentials/base.js';
import { ApiCredentialStatus } from '../src/apiCredentials/base.js';
import { ServiceSession } from '../src/services/core/base.js';

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

describe('Ramp.getSession (browser login)', () => {
  it('returns the OAuth (PKCE) browser-login session', () => {
    const session = RAMP.getSession('latchkey');
    expect(session).toBeInstanceOf(ServiceSession);
    expect(session.constructor.name).toBe('RampOAuthServiceSession');
  });

  it('does not require a prepare() step (browser login needs no pre-set credentials)', () => {
    const session = RAMP.getSession('latchkey');
    // authBrowser only demands credentials up front when prepare() is defined.
    // Cast away the method type so the unbound-method lint rule doesn't fire on
    // this presence check.
    expect((session as { prepare?: unknown }).prepare).toBeUndefined();
  });
});

describe('Ramp.info', () => {
  it('documents the browser-login pathway and the developer API base', () => {
    expect(RAMP.info).toContain('auth browser ramp');
    expect(RAMP.info).toContain('https://api.ramp.com/developer/v1');
  });
});

describe('Ramp.refreshCredentials with OAuth (browser-login) credentials', () => {
  it('returns null when there is no refresh token (cannot refresh offline)', async () => {
    const creds = new OAuthCredentials('ramp_id_test', '', 'access-token', undefined, FUTURE);
    expect(await RAMP.refreshCredentials(creds)).toBeNull();
  });

  it('returns null for unrelated credential types', async () => {
    expect(await RAMP.refreshCredentials(new AuthorizationBearer('tok'))).toBeNull();
  });
});

describe('Ramp.checkApiCredentials with OAuth (browser-login) credentials', () => {
  it('reports Valid when a live (unexpired) access token is held', async () => {
    const creds = new OAuthCredentials('ramp_id_test', '', 'access-token', 'refresh-token', FUTURE);
    expect(await RAMP.checkApiCredentials(creds)).toBe(ApiCredentialStatus.Valid);
  });

  it('reports Invalid when there is no access token and no way to obtain one', async () => {
    const creds = new OAuthCredentials('ramp_id_test', '', undefined, undefined, undefined);
    expect(await RAMP.checkApiCredentials(creds)).toBe(ApiCredentialStatus.Invalid);
  });

  it('reports Missing for unrelated credential types', async () => {
    expect(await RAMP.checkApiCredentials(new AuthorizationBearer('tok'))).toBe(
      ApiCredentialStatus.Missing
    );
  });
});

describe('Ramp.getCredentialsNoCurl (client_credentials pathway still works)', () => {
  it('builds production RampCredentials and joins scopes', () => {
    const creds = RAMP.getCredentialsNoCurl(['cid', 'secret', 'transactions:read', 'users:read']);
    expect(creds).toBeInstanceOf(RampCredentials);
    const ramp = creds as RampCredentials;
    expect(ramp.clientId).toBe('cid');
    expect(ramp.clientSecret).toBe('secret');
    expect(ramp.scope).toBe('transactions:read users:read');
  });

  it('throws when required arguments are missing', () => {
    expect(() => RAMP.getCredentialsNoCurl(['cid'])).toThrow();
  });
});
