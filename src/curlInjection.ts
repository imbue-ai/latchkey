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
import { parseCurlArgs } from '@imbue-ai/detent';
import { ErrorMessages } from './errorMessages.js';
import type { ServiceRegistry } from './serviceRegistry.js';
import type { Service } from './services/core/base.js';

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

  constructor(serviceName: string, account?: string) {
    super(ErrorMessages.noCredentialsFound(serviceName, account));
    this.name = 'NoCredentialsForServiceError';
    this.serviceName = serviceName;
  }
}

export class CredentialsExpiredError extends Error {
  readonly serviceName: string;

  constructor(serviceName: string, account?: string) {
    super(ErrorMessages.credentialsExpired(serviceName, account));
    this.name = 'CredentialsExpiredError';
    this.serviceName = serviceName;
  }
}

export interface CurlInjectionDependencies {
  readonly registry: ServiceRegistry;
  readonly checkPermission: (
    request: Request,
    configPath: string,
    doNotUseBuiltinSchemas: boolean
  ) => Promise<boolean>;
  readonly permissionsConfigPath: string;
  readonly permissionsDoNotUseBuiltinSchemas: boolean;
  readonly passthroughUnknown: boolean;
  readonly credentialsRefreshDisabled: boolean;
  /**
   * Account to use for the credentials. When omitted, the single stored
   * account is used automatically; if a service has multiple accounts an
   * `AmbiguousAccountError` is raised so the caller can require `--account`.
   */
  readonly account?: string;
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
  dependencies: CurlInjectionDependencies,
  /**
   * The actual request body, when the caller has it available in memory but
   * passes it to curl out-of-band (e.g. the gateway streams it via
   * `--data-binary @-` on stdin). In that case the parsed curl arguments only
   * contain the placeholder `@-`, so the permission check would otherwise see
   * `"@-"` as the body. Supplying it here lets the permission check inspect
   * the real body without changing how curl is actually invoked.
   */
  requestBodyForPermissionCheck?: Buffer | null
): Promise<readonly string[]> {
  // Parse the curl arguments once for the permission check. A parse failure
  // here means the user's curl invocation is malformed, which is treated as
  // a URL-extraction failure (the same category as the second parse below),
  // not a permission-check failure.
  let parsedRequest: Request;
  try {
    parsedRequest = parseCurlArgs(curlArguments);
  } catch (error) {
    if (error instanceof CurlParseError) {
      throw new UrlExtractionFailedError(error.message);
    }
    throw error;
  }
  // When the real body was supplied out-of-band, rebuild the request so the
  // permission check sees the actual payload instead of the `@-` placeholder.
  if (requestBodyForPermissionCheck !== undefined && requestBodyForPermissionCheck !== null) {
    parsedRequest = new Request(parsedRequest.url, {
      method: parsedRequest.method,
      headers: parsedRequest.headers,
      body: requestBodyForPermissionCheck,
    });
  }
  const allowed = await dependencies.checkPermission(
    parsedRequest,
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

  // A single URL can match several services when an API is shared (e.g. the
  // Google Drive files API is used by Drive, Docs, and Sheets). Pick the
  // matching service that actually has usable credentials, preferring one
  // whose credentials are not expired so we avoid unnecessary refreshes and
  // network round-trips. Registration order breaks ties, which lets the
  // canonical owner win when it too has usable credentials.
  const candidates = dependencies.registry.getCandidatesByUrl(url);
  const firstCandidate = candidates[0];
  if (firstCandidate === undefined) {
    if (dependencies.passthroughUnknown) {
      return [...curlArguments];
    }
    throw new NoServiceForUrlError(url);
  }

  interface Selection {
    service: Service;
    apiCredentials: ApiCredentials;
  }
  let selection: Selection | null = null;
  let fallbackWithCredentials: Selection | null = null;
  const account = dependencies.account;
  // `get` resolves the account itself: it returns null when the requested
  // account is absent (so we move on to the next candidate) and raises
  // AmbiguousAccountError when several accounts exist and none was requested,
  // which bubbles up so the caller can require --account.
  for (const candidate of candidates) {
    const candidateCredentials = apiCredentialStore.get(candidate.name, account);
    if (candidateCredentials === null) {
      continue;
    }
    fallbackWithCredentials ??= { service: candidate, apiCredentials: candidateCredentials };
    if (candidateCredentials.isExpired() !== true) {
      selection = { service: candidate, apiCredentials: candidateCredentials };
      break;
    }
  }

  // Fall back to the first candidate that has credentials at all (they may be
  // expired and refreshable below). If nothing has credentials, report against
  // the first matching service for a sensible error message.
  const chosen = selection ?? fallbackWithCredentials;
  if (chosen === null) {
    if (dependencies.passthroughUnknown) {
      return [...curlArguments];
    }
    throw new NoCredentialsForServiceError(firstCandidate.name, account);
  }

  const service = chosen.service;
  let apiCredentials: ApiCredentials = chosen.apiCredentials;

  if (apiCredentials.isExpired() === true) {
    apiCredentials = await maybeRefreshCredentials(
      service,
      apiCredentials,
      apiCredentialStore,
      dependencies.credentialsRefreshDisabled,
      account
    );
    if (apiCredentials.isExpired() === true) {
      throw new CredentialsExpiredError(service.name, account);
    }
  }

  if (service.adjustCredentials !== undefined) {
    apiCredentials = service.adjustCredentials(apiCredentials, url);
  }

  return await apiCredentials.injectIntoCurlCall(curlArguments);
}
