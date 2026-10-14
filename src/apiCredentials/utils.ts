/**
 * Shared credential utilities used by both the CLI and the gateway.
 */

import { ApiCredentialStatus, type ApiCredentials } from './base.js';
import type { ApiCredentialStore } from './store.js';
import type { Service } from '../services/core/base.js';

/**
 * Refreshes currently in flight, keyed by service and account. A long-running
 * process such as the gateway can receive many requests for the same expired
 * credentials at once; without this, each of them would call the service's
 * refresh endpoint with the same refresh token, which risks exhausting it
 * (many providers rotate refresh tokens and invalidate the old one).
 */
const inFlightRefreshes = new Map<string, Promise<ApiCredentials | null>>();

function refreshKey(serviceName: string, account: string | undefined): string {
  // An unspecified account always resolves to the service's single stored
  // account, so it is safe to treat it as its own key.
  return `${serviceName}\u0000${account ?? ''}`;
}

async function refreshAndSave(
  service: Service,
  apiCredentials: ApiCredentials,
  apiCredentialStore: ApiCredentialStore,
  account: string | undefined
): Promise<ApiCredentials | null> {
  const refreshedCredentials = await service.refreshCredentials!(apiCredentials);
  if (refreshedCredentials !== null) {
    apiCredentialStore.save(service.name, refreshedCredentials, account);
  }
  return refreshedCredentials;
}

/**
 * Try to refresh expired credentials if the service supports it.
 * Returns refreshed credentials if successful, otherwise returns the original credentials.
 *
 * Only one refresh per service and account runs at a time within the process:
 * concurrent callers wait for the refresh already in flight and share its
 * result instead of issuing their own refresh request.
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
  const key = refreshKey(service.name, account);
  let refresh = inFlightRefreshes.get(key);
  if (refresh === undefined) {
    refresh = refreshAndSave(service, apiCredentials, apiCredentialStore, account).finally(() => {
      inFlightRefreshes.delete(key);
    });
    inFlightRefreshes.set(key, refresh);
  }
  const refreshedCredentials = await refresh;
  return refreshedCredentials ?? apiCredentials;
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
