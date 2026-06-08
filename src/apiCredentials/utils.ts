/**
 * Shared credential utilities used by both the CLI and the gateway.
 */

import { ApiCredentialStatus, type ApiCredentials } from './base.js';
import type { ApiCredentialStore } from './store.js';
import type { Service } from '../services/core/base.js';

/**
 * Try to refresh expired credentials if the service supports it.
 * Returns refreshed credentials if successful, otherwise returns the original credentials.
 *
 * When `disableRefresh` is true, the credentials are never refreshed. This is
 * used when the credentials are shared with another machine and refreshing here
 * would otherwise risk exhausting the refresh token.
 */
export async function maybeRefreshCredentials(
  service: Service,
  apiCredentials: ApiCredentials,
  apiCredentialStore: ApiCredentialStore,
  disableRefresh = false
): Promise<ApiCredentials> {
  if (disableRefresh || apiCredentials.isExpired() !== true || !service.refreshCredentials) {
    return apiCredentials;
  }
  const refreshedCredentials = await service.refreshCredentials(apiCredentials);
  if (refreshedCredentials !== null) {
    apiCredentialStore.save(service.name, refreshedCredentials);
    return refreshedCredentials;
  }
  return apiCredentials;
}

export async function getCredentialStatus(
  service: Service,
  credentials: ApiCredentials | null,
  apiCredentialStore: ApiCredentialStore,
  disableRefresh = false
): Promise<ApiCredentialStatus> {
  if (credentials === null) {
    return ApiCredentialStatus.Missing;
  }
  const refreshed = await maybeRefreshCredentials(
    service,
    credentials,
    apiCredentialStore,
    disableRefresh
  );
  return await service.checkApiCredentials(refreshed);
}
