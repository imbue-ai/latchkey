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
  disableRefresh = false,
  account?: string
): Promise<ApiCredentials> {
  if (disableRefresh || apiCredentials.isExpired() !== true || !service.refreshCredentials) {
    return apiCredentials;
  }
  const refreshedCredentials = await service.refreshCredentials(apiCredentials);
  if (refreshedCredentials !== null) {
    apiCredentialStore.save(service.name, refreshedCredentials, account);
    return refreshedCredentials;
  }
  return apiCredentials;
}

export async function getCredentialStatus(
  service: Service,
  credentials: ApiCredentials | null,
  apiCredentialStore: ApiCredentialStore,
  disableRefresh = false,
  offline = false,
  account?: string
): Promise<ApiCredentialStatus> {
  if (credentials === null) {
    return ApiCredentialStatus.Missing;
  }
  // In offline mode we never send a validation request, so we can only report
  // that credentials exist without knowing whether they are actually valid.
  if (offline) {
    return ApiCredentialStatus.Unknown;
  }
  const refreshed = await maybeRefreshCredentials(
    service,
    credentials,
    apiCredentialStore,
    disableRefresh,
    account
  );
  return service.checkApiCredentials(refreshed);
}
