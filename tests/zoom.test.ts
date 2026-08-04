import { describe, it, expect, afterEach } from 'vitest';
import { ApiCredentialsUsageError, AuthorizationBearer } from '../src/apiCredentials/base.js';
import { resetAsyncSubprocessRunner, setAsyncSubprocessRunner } from '../src/curl.js';
import {
  isZoomSignedInHomeUrl,
  ZOOM,
  ZoomCredentialError,
  ZoomServerToServerCredentials,
} from '../src/services/zoom.js';

const APP_CREDENTIALS = new ZoomServerToServerCredentials(
  'account-id',
  'client-id',
  'client-secret'
);

function inOneHour(): string {
  return new Date(Date.now() + 3600_000).toISOString();
}

afterEach(() => {
  resetAsyncSubprocessRunner();
});

describe('ZoomServerToServerCredentials', () => {
  it('injects the access token as a bearer token', async () => {
    const credentials = APP_CREDENTIALS.withAccessToken('minted-token', inOneHour());
    await expect(credentials.injectIntoCurlCall([])).resolves.toEqual([
      '-H',
      'Authorization: Bearer minted-token',
    ]);
  });

  it('refuses to be used before an access token has been minted', () => {
    expect(() => APP_CREDENTIALS.injectIntoCurlCall([])).toThrow(ApiCredentialsUsageError);
  });

  it('counts a missing access token as expired, so one gets minted', () => {
    expect(APP_CREDENTIALS.isExpired()).toBe(true);
  });

  it('counts a token close to its expiry as expired', () => {
    const almostExpired = APP_CREDENTIALS.withAccessToken(
      'minted-token',
      new Date(Date.now() + 10_000).toISOString()
    );
    expect(almostExpired.isExpired()).toBe(true);
    expect(APP_CREDENTIALS.withAccessToken('minted-token', inOneHour()).isExpired()).toBe(false);
  });
});

describe('Zoom.refreshCredentials', () => {
  it('mints an access token with the account_credentials grant', async () => {
    let observedArguments: readonly string[] = [];
    setAsyncSubprocessRunner((args) => {
      observedArguments = args;
      return Promise.resolve({
        returncode: 0,
        stdout: Buffer.from('{"access_token":"minted-token","expires_in":3600}'),
        stderr: '',
      });
    });

    const refreshed = await ZOOM.refreshCredentials(APP_CREDENTIALS);

    expect(refreshed).toBeInstanceOf(ZoomServerToServerCredentials);
    expect((refreshed as ZoomServerToServerCredentials).accessToken).toBe('minted-token');
    expect(refreshed?.isExpired()).toBe(false);
    expect(observedArguments).toContain('https://zoom.us/oauth/token');
    expect(observedArguments).toContain('client-id:client-secret');
    expect(observedArguments).toContain('grant_type=account_credentials&account_id=account-id');
  });

  it('reports failure when Zoom refuses to issue a token', async () => {
    setAsyncSubprocessRunner(() =>
      Promise.resolve({
        returncode: 0,
        stdout: Buffer.from('{"reason":"Invalid client_id or client_secret"}'),
        stderr: '',
      })
    );
    await expect(ZOOM.refreshCredentials(APP_CREDENTIALS)).resolves.toBeNull();
  });

  it('leaves other credential types alone', async () => {
    await expect(ZOOM.refreshCredentials(new AuthorizationBearer('token'))).resolves.toBeNull();
  });
});

describe('Zoom.getCredentialsNoCurl', () => {
  it('accepts the app credential triple', () => {
    const credentials = ZOOM.getCredentialsNoCurl(['account-id', 'client-id', 'client-secret']);
    expect(credentials).toBeInstanceOf(ZoomServerToServerCredentials);
  });

  it('rejects an incomplete triple', () => {
    expect(() => ZOOM.getCredentialsNoCurl(['account-id', 'client-id'])).toThrow(
      ZoomCredentialError
    );
  });
});

describe('isZoomSignedInHomeUrl', () => {
  it('accepts the home page on any regional host, and as a bare redirect path', () => {
    expect(isZoomSignedInHomeUrl('https://zoom.us/myhome')).toBe(true);
    expect(isZoomSignedInHomeUrl('https://us05web.zoom.us/myhome')).toBe(true);
    expect(isZoomSignedInHomeUrl('https://us05web.zoom.us/myhome?from=signin')).toBe(true);
    expect(isZoomSignedInHomeUrl('https://us05web.zoom.us/myhome/setting')).toBe(true);
    expect(isZoomSignedInHomeUrl('/myhome')).toBe(true);
  });

  it('rejects other pages, and other hosts borrowing the path', () => {
    expect(isZoomSignedInHomeUrl('https://zoom.us/signin#/login')).toBe(false);
    expect(isZoomSignedInHomeUrl('https://us05web.zoom.us/myhomepage')).toBe(false);
    expect(isZoomSignedInHomeUrl('https://marketplace.zoom.us/user/build')).toBe(false);
    expect(isZoomSignedInHomeUrl('https://not-zoom.example.com/myhome')).toBe(false);
  });
});

describe('Zoom.getAccount', () => {
  it('falls back to the app account id when /users/me has no user context', async () => {
    setAsyncSubprocessRunner(() =>
      Promise.resolve({
        returncode: 0,
        stdout: Buffer.from('{"code":124,"message":"Invalid access token."}'),
        stderr: '',
      })
    );
    const credentials = APP_CREDENTIALS.withAccessToken('minted-token', inOneHour());
    await expect(ZOOM.getAccount(credentials)).resolves.toBe('account-id');
  });
});
