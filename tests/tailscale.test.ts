import { describe, it, expect, afterEach } from 'vitest';
import { TAILSCALE, TailscaleCredentials } from '../src/services/tailscale.js';
import { ApiCredentialStatus } from '../src/apiCredentials/base.js';
import {
  serializeCredentials,
  deserializeCredentials,
  ApiCredentialsSchema,
} from '../src/apiCredentials/serialization.js';
import { BUILTIN_SERVICE_REGISTRY } from './builtinServiceRegistry.js';
import { resetAsyncSubprocessRunner, setAsyncSubprocessRunner } from '../src/curl.js';
import type { Service } from '../src/services/core/base.js';

afterEach(() => {
  resetAsyncSubprocessRunner();
});

function mockCurlStdout(stdout: string): void {
  setAsyncSubprocessRunner(() =>
    Promise.resolve({ returncode: 0, stdout: Buffer.from(stdout), stderr: '' })
  );
}

function primaryServiceForUrl(url: string): Service | null {
  return BUILTIN_SERVICE_REGISTRY.getByUrl(url);
}

describe('Tailscale URL matching', () => {
  it('matches the admin API host and not lookalikes', () => {
    expect(primaryServiceForUrl('https://api.tailscale.com/api/v2/tailnet/example.com/users')).toBe(
      TAILSCALE
    );
    expect(primaryServiceForUrl('https://api.tailscale.com/api/v2/tailnet/example.com/keys')).toBe(
      TAILSCALE
    );
  });

  it('does not match the admin console or login host', () => {
    expect(primaryServiceForUrl('https://console.tailscale.com/admin/users')).toBeNull();
    expect(primaryServiceForUrl('https://login.tailscale.com/admin')).toBeNull();
    expect(primaryServiceForUrl('https://api.tailscale.com.example.com/api/v2/')).toBeNull();
  });
});

describe('Tailscale credentials', () => {
  it('inject an Authorization: Bearer header', async () => {
    const credentials = new TailscaleCredentials('tskey-api-kTest11CNTRL-secret', 'example.com');
    const injected = await credentials.injectIntoCurlCall(['https://api.tailscale.com/api/v2/']);
    expect(injected).toEqual([
      '-H',
      'Authorization: Bearer tskey-api-kTest11CNTRL-secret',
      'https://api.tailscale.com/api/v2/',
    ]);
  });

  it('reports the tailnet as the account and does not claim to know expiry', async () => {
    const credentials = new TailscaleCredentials('tskey-api-kTest11CNTRL-secret', 'example.com');
    expect(await TAILSCALE.getAccount(credentials)).toBe('example.com');
    expect(credentials.isExpired()).toBeUndefined();
  });

  it('survives a serialization round-trip', () => {
    const credentials = new TailscaleCredentials('tskey-api-kRound11CNTRL-secret', 'example.com');
    const data = serializeCredentials(credentials);
    // The discriminated union accepts the serialized form.
    ApiCredentialsSchema.parse(data);
    const restored = deserializeCredentials(data);
    expect(restored).toBeInstanceOf(TailscaleCredentials);
    expect((restored as TailscaleCredentials).token).toBe('tskey-api-kRound11CNTRL-secret');
    expect((restored as TailscaleCredentials).tailnet).toBe('example.com');
  });
});

describe('Tailscale credential check', () => {
  // The check targets /tailnet/{tailnet}/settings; the response body is
  // irrelevant, only the trailing HTTP status code (appended by `-w`) decides.
  it('reports valid on a 200 from the tailnet settings endpoint', async () => {
    mockCurlStdout('{"httpsEnabled":true}\n200');
    const credentials = new TailscaleCredentials('tskey-api-kTest11CNTRL-secret', 'example.com');
    expect(await TAILSCALE.checkApiCredentials(credentials)).toBe(ApiCredentialStatus.Valid);
  });

  it('reports invalid on a 401 (expired or revoked token)', async () => {
    mockCurlStdout('\n401');
    const credentials = new TailscaleCredentials('tskey-api-kTest11CNTRL-secret', 'example.com');
    expect(await TAILSCALE.checkApiCredentials(credentials)).toBe(ApiCredentialStatus.Invalid);
  });

  it('reports invalid on a 404 (unknown tailnet)', async () => {
    mockCurlStdout('\n404');
    const credentials = new TailscaleCredentials('tskey-api-kTest11CNTRL-secret', 'example.com');
    expect(await TAILSCALE.checkApiCredentials(credentials)).toBe(ApiCredentialStatus.Invalid);
  });

  it('reports unknown for a non-Tailscale credential (manual auth set)', async () => {
    const raw = {
      injectIntoCurlCall: () => Promise.resolve([] as readonly string[]),
      isExpired: () => undefined,
    } as never;
    expect(await TAILSCALE.checkApiCredentials(raw)).toBe(ApiCredentialStatus.Unknown);
  });
});
