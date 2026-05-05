import { describe, it } from 'vitest';
import {
  startOAuthCallbackServer,
  generateCodeVerifier,
  generateCodeChallenge,
  exchangeCodeForTokens,
  refreshAccessToken,
  OAuthTokenExchangeError,
  OAuthCallbackServerTimeoutError,
} from '../src/oauthUtils.js';

void startOAuthCallbackServer;
void exchangeCodeForTokens;
void refreshAccessToken;
void OAuthTokenExchangeError;
void OAuthCallbackServerTimeoutError;

describe('startOAuthCallbackServer', () => {
  it.todo('add tests');
});

describe('generateCodeVerifier', () => {
  it('just runs', () => {
    generateCodeVerifier();
  });
});

describe('generateCodeChallenge', () => {
  it('just runs', () => {
    generateCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  });
});

describe('exchangeCodeForTokens', () => {
  it.todo('add tests');
});

describe('refreshAccessToken', () => {
  it.todo('add tests');
});
