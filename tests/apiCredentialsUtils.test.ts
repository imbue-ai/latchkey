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
