/**
 * Shared credential-injection pipeline used by both `latchkey curl` and the
 * gateway's `/gateway/<url>` proxy.
 *
 * Given the raw curl arguments of an outgoing request, this function performs
 * the permission check, URL extraction, service lookup, credential load and
 * expiry/refresh steps, and returns the final argument list to pass to curl.
 * Problems are reported as dedicated error subclasses. Actually invoking curl
 * is left to the caller, so the CLI can inherit stdio while the gateway can
 * stream request bodies and capture response headers.
 */

import type { ApiCredentials } from './apiCredentials/base.js';
import type { ApiCredentialStore } from './apiCredentials/store.js';
import { maybeRefreshCredentials } from './apiCredentials/utils.js';
import { CurlParseError, extractUrlFromCurlArguments } from './curl.js';
import { ErrorMessages } from './errorMessages.js';
import type { ServiceRegistry } from './serviceRegistry.js';

export class RequestNotPermittedError extends Error {
  constructor() {
    super(ErrorMessages.requestNotPermitted);
    this.name = 'RequestNotPermittedError';
  }
}

export class UrlExtractionFailedError extends Error {
  constructor(detail?: string) {
    super(
      detail === undefined
        ? ErrorMessages.couldNotExtractUrl
        : `${ErrorMessages.couldNotExtractUrlBrief} ${detail}`
    );
    this.name = 'UrlExtractionFailedError';
  }
}

export class NoServiceForUrlError extends Error {
  readonly url: string;

  constructor(url: string) {
    super(ErrorMessages.noServiceMatchesUrl(url));
    this.name = 'NoServiceForUrlError';
    this.url = url;
  }
}

export class NoCredentialsForServiceError extends Error {
  readonly serviceName: string;

  constructor(serviceName: string) {
    super(ErrorMessages.noCredentialsFound(serviceName));
    this.name = 'NoCredentialsForServiceError';
    this.serviceName = serviceName;
  }
}

export class CredentialsExpiredError extends Error {
  readonly serviceName: string;

  constructor(serviceName: string) {
    super(ErrorMessages.credentialsExpired(serviceName));
    this.name = 'CredentialsExpiredError';
    this.serviceName = serviceName;
  }
}

export interface CurlInjectionDependencies {
  readonly registry: ServiceRegistry;
  readonly checkPermission: (
    curlArguments: readonly string[],
    configPath: string,
    doNotUseBuiltinSchemas: boolean
  ) => Promise<boolean>;
  readonly permissionsConfigPath: string;
  readonly permissionsDoNotUseBuiltinSchemas: boolean;
  readonly passthroughUnknown: boolean;
}

/**
 * Run the credential-injection pipeline for a curl invocation and return the
 * final argument list to pass to curl. On problems, throws one of the error
 * classes exported from this module (or a `PermissionCheckError` from the
 * underlying permission check).
 */
export async function prepareCurlInvocation(
  curlArguments: readonly string[],
  apiCredentialStore: ApiCredentialStore,
  dependencies: CurlInjectionDependencies
): Promise<readonly string[]> {
  const allowed = await dependencies.checkPermission(
    curlArguments,
    dependencies.permissionsConfigPath,
    dependencies.permissionsDoNotUseBuiltinSchemas
  );
  if (!allowed) {
    throw new RequestNotPermittedError();
  }

  let url: string | null;
  try {
    url = extractUrlFromCurlArguments(curlArguments);
  } catch (error) {
    if (error instanceof CurlParseError) {
      throw new UrlExtractionFailedError(error.message);
    }
    throw error;
  }
  if (url === null) {
    throw new UrlExtractionFailedError();
  }

  const service = dependencies.registry.getByUrl(url);
  if (service === null) {
    if (dependencies.passthroughUnknown) {
      return [...curlArguments];
    }
    throw new NoServiceForUrlError(url);
  }

  let apiCredentials: ApiCredentials | null = apiCredentialStore.get(service.name);
  if (apiCredentials === null) {
    if (dependencies.passthroughUnknown) {
      return [...curlArguments];
    }
    throw new NoCredentialsForServiceError(service.name);
  }

  if (apiCredentials.isExpired() === true) {
    apiCredentials = await maybeRefreshCredentials(service, apiCredentials, apiCredentialStore);
    if (apiCredentials.isExpired() === true) {
      throw new CredentialsExpiredError(service.name);
    }
  }

  return await apiCredentials.injectIntoCurlCall(curlArguments);
}
