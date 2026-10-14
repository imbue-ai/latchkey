import { describe, it, expect, vi } from 'vitest';
import { maybeRefreshCredentials } from '../src/apiCredentials/utils.js';
import { OAuthCredentials, type ApiCredentials } from '../src/apiCredentials/base.js';
import type { ApiCredentialStore } from '../src/apiCredentials/store.js';
import type { Service } from '../src/services/core/base.js';

function createExpiredOAuthCredentials(): OAuthCredentials {
  const past = new Date(Date.now() - 60_000).toISOString();
  return new OAuthCredentials('client-id', 'client-secret', 'access', 'refresh', past);
}

function createStoreStub(): { store: ApiCredentialStore; save: ReturnType<typeof vi.fn> } {
  const save = vi.fn();
  return { store: { save } as unknown as ApiCredentialStore, save };
}

describe('maybeRefreshCredentials', () => {
  it('refreshes expired credentials when refresh is enabled', async () => {
    const expired = createExpiredOAuthCredentials();
    const refreshed = new OAuthCredentials('client-id', 'client-secret', 'new-access', 'refresh');
    const refreshCredentials = vi.fn(
      (_credentials: ApiCredentials): Promise<ApiCredentials | null> => Promise.resolve(refreshed)
    );
    const service = { name: 'demo', refreshCredentials } as unknown as Service;
    const { store, save } = createStoreStub();

    const result = await maybeRefreshCredentials(service, expired, store, false);

    expect(refreshCredentials).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith('demo', refreshed, undefined);
    expect(result).toBe(refreshed);
  });

  it('shares a single in-flight refresh between concurrent callers', async () => {
    const expired = createExpiredOAuthCredentials();
    const refreshed = new OAuthCredentials('client-id', 'client-secret', 'new-access', 'refresh');
    let resolveRefresh!: (credentials: ApiCredentials | null) => void;
    const refreshCredentials = vi.fn(
      (_credentials: ApiCredentials): Promise<ApiCredentials | null> =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        })
    );
    const service = { name: 'demo', refreshCredentials } as unknown as Service;
    const { store, save } = createStoreStub();

    const first = maybeRefreshCredentials(service, expired, store, false, 'alice');
    const second = maybeRefreshCredentials(service, expired, store, false, 'alice');
    expect(refreshCredentials).toHaveBeenCalledOnce();

    resolveRefresh(refreshed);
    expect(await first).toBe(refreshed);
    expect(await second).toBe(refreshed);
    expect(refreshCredentials).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();

    // Once the refresh has settled, a later call is free to refresh again.
    const third = maybeRefreshCredentials(service, expired, store, false, 'alice');
    expect(refreshCredentials).toHaveBeenCalledTimes(2);
    resolveRefresh(refreshed);
    expect(await third).toBe(refreshed);
  });

  it('refreshes different services and accounts independently', async () => {
    const expired = createExpiredOAuthCredentials();
    const refreshed = new OAuthCredentials('client-id', 'client-secret', 'new-access', 'refresh');
    const pending: ((credentials: ApiCredentials | null) => void)[] = [];
    const refreshCredentials = vi.fn(
      (_credentials: ApiCredentials): Promise<ApiCredentials | null> =>
        new Promise((resolve) => {
          pending.push(resolve);
        })
    );
    const demo = { name: 'demo', refreshCredentials } as unknown as Service;
    const other = { name: 'other', refreshCredentials } as unknown as Service;
    const { store } = createStoreStub();

    const calls = [
      maybeRefreshCredentials(demo, expired, store, false, 'alice'),
      maybeRefreshCredentials(demo, expired, store, false, 'bob'),
      maybeRefreshCredentials(other, expired, store, false, 'alice'),
    ];
    expect(refreshCredentials).toHaveBeenCalledTimes(3);
    for (const resolve of pending) {
      resolve(refreshed);
    }
    await Promise.all(calls);
  });

  it('returns the original credentials to every waiter when the shared refresh fails', async () => {
    const expired = createExpiredOAuthCredentials();
    const refreshCredentials = vi.fn(
      (_credentials: ApiCredentials): Promise<ApiCredentials | null> => Promise.resolve(null)
    );
    const service = { name: 'demo', refreshCredentials } as unknown as Service;
    const { store, save } = createStoreStub();

    const [first, second] = await Promise.all([
      maybeRefreshCredentials(service, expired, store, false),
      maybeRefreshCredentials(service, expired, store, false),
    ]);

    expect(refreshCredentials).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    expect(first).toBe(expired);
    expect(second).toBe(expired);
  });

  it('propagates a thrown refresh error to every waiter and releases the lock', async () => {
    const expired = createExpiredOAuthCredentials();
    const refreshCredentials = vi
      .fn<(credentials: ApiCredentials) => Promise<ApiCredentials | null>>()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(
        new OAuthCredentials('client-id', 'client-secret', 'new-access', 'refresh')
      );
    const service = { name: 'demo', refreshCredentials } as unknown as Service;
    const { store } = createStoreStub();

    const first = maybeRefreshCredentials(service, expired, store, false);
    const second = maybeRefreshCredentials(service, expired, store, false);
    await expect(first).rejects.toThrow('network down');
    await expect(second).rejects.toThrow('network down');
    expect(refreshCredentials).toHaveBeenCalledOnce();

    // The failed refresh must not leave a stale lock behind.
    const retried = await maybeRefreshCredentials(service, expired, store, false);
    expect(retried.isExpired()).not.toBe(true);
    expect(refreshCredentials).toHaveBeenCalledTimes(2);
  });

  it('does not refresh when refresh is disabled', async () => {
    const expired = createExpiredOAuthCredentials();
    const refreshCredentials = vi.fn();
    const service = { name: 'demo', refreshCredentials } as unknown as Service;
    const { store, save } = createStoreStub();

    const result = await maybeRefreshCredentials(service, expired, store, true);

    expect(refreshCredentials).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(result).toBe(expired);
  });
});
