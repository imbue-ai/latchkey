/**
 * Shared credential utilities used by both the CLI and the gateway.
 */

import { ApiCredentialStatus, type ApiCredentials } from './apiCredentials.js';
import type { ApiCredentialStore } from './apiCredentialStore.js';
import type { Service } from './services/core/base.js';

/**
 * Try to refresh expired credentials if the service supports it.
 * Returns refreshed credentials if successful, otherwise returns the original credentials.
 */
export async function maybeRefreshCredentials(
  service: Service,
  apiCredentials: ApiCredentials,
  apiCredentialStore: ApiCredentialStore
): Promise<ApiCredentials> {
  if (apiCredentials.isExpired() !== true || !service.refreshCredentials) {
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
  apiCredentialStore: ApiCredentialStore
): Promise<ApiCredentialStatus> {
  if (credentials === null) {
    return ApiCredentialStatus.Missing;
  }
  const refreshed = await maybeRefreshCredentials(service, credentials, apiCredentialStore);
  return service.checkApiCredentials(refreshed);
}
