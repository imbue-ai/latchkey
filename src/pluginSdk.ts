/**
 * The `latchkey/plugin` entry point.
 *
 * At runtime, this builds the object handed to a plugin's factory: every value
 * a plugin may use, so that a bare clone with no node_modules of its own has
 * everything it needs. For plugin authors, it is also where the types come
 * from, with `import type { LatchkeySdk, Service } from 'latchkey/plugin'`.
 * That is the only way a plugin imports from it: the SDK object, not this
 * module, is what carries the classes and helpers.
 *
 * Plugins declare the Latchkey versions they support as a semver range (see
 * `src/plugins.ts`), so this surface follows semantic versioning: additions
 * are welcome in any release, while removing or changing anything here is a
 * breaking change that calls for a new major version of Latchkey.
 */

import { z } from 'zod';
import {
  ApiCredentialStatus,
  ApiCredentialsUsageError,
  AuthorizationBare,
  AuthorizationBearer,
  OAuthCredentials,
  RawCurlCredentials,
} from './apiCredentials/base.js';
import {
  DEFAULT_ACCOUNT,
  fetchAccountFromEndpoint,
  tryParseJson,
} from './apiCredentials/account.js';
import { runCapturedAsync } from './curl.js';
import {
  DEFAULT_OAUTH_CALLBACK_PATH,
  OAuthCallbackServerTimeoutError,
  OAuthTokenExchangeError,
  buildLoopbackRedirectUri,
  exchangeCodeForTokens,
  generateCodeChallenge,
  generateCodeVerifier,
  readRedirectUriOverride,
  refreshAccessToken,
  startOAuthCallbackServer,
} from './oauthUtils.js';
import { BrowserFeaturesUnavailableError, loadPlaywright } from './playwrightLoader.js';
import {
  BrowserDisabledError,
  BrowserFlowsNotSupportedError,
  CredentialFormFieldMissingError,
  CredentialFormValues,
  GraphicalEnvironmentNotFoundError,
  generateLatchkeyAppName,
  hasGraphicalEnvironment,
  requestCredentialsFromUser,
  showSpinnerPage,
  typeLikeHuman,
  withTempBrowserContext,
} from './playwrightUtils.js';
import { BUILTIN_SERVICES } from './serviceRegistry.js';
import {
  BrowserFollowupServiceSession,
  FollowupWork,
  LoginCancelledError,
  LoginFailedError,
  NoCurlCredentialsNotSupportedError,
  PrepareInputInvalidError,
  PrepareNotSupportedError,
  RedirectUriOverrideSchema,
  Service,
  ServiceSession,
  SimpleServiceSession,
  buildFollowupSpinnerDetails,
  buildPreparedCredentials,
  describeSchemaIssues,
  isBrowserClosedError,
  isResponseBodyUnavailableError,
  isTimeoutError,
} from './services/core/base.js';
import { CookieCaptureLoginFlow } from './services/core/loginFlows/cookieCapture.js';
import { TokenCaptureLoginFlow } from './services/core/loginFlows/tokenCapture.js';
import { RegisteredService } from './services/core/registered.js';
import { GoogleService } from './services/google/base.js';

export function createLatchkeySdk(latchkeyVersion: string) {
  return Object.freeze({
    latchkeyVersion,
    z,
    builtinServices: BUILTIN_SERVICES,

    // Services
    Service,
    ServiceSession,
    SimpleServiceSession,
    BrowserFollowupServiceSession,
    FollowupWork,
    RegisteredService,
    GoogleService,
    CookieCaptureLoginFlow,
    TokenCaptureLoginFlow,
    buildFollowupSpinnerDetails,
    buildPreparedCredentials,
    describeSchemaIssues,
    isBrowserClosedError,
    isResponseBodyUnavailableError,
    isTimeoutError,
    LoginCancelledError,
    LoginFailedError,
    NoCurlCredentialsNotSupportedError,
    PrepareNotSupportedError,
    PrepareInputInvalidError,
    RedirectUriOverrideSchema,

    // Credentials
    ApiCredentialStatus,
    ApiCredentialsUsageError,
    AuthorizationBearer,
    AuthorizationBare,
    RawCurlCredentials,
    OAuthCredentials,
    DEFAULT_ACCOUNT,
    fetchAccountFromEndpoint,
    tryParseJson,

    // Browser automation
    loadPlaywright,
    withTempBrowserContext,
    showSpinnerPage,
    requestCredentialsFromUser,
    typeLikeHuman,
    generateLatchkeyAppName,
    hasGraphicalEnvironment,
    CredentialFormValues,
    CredentialFormFieldMissingError,
    BrowserDisabledError,
    BrowserFlowsNotSupportedError,
    BrowserFeaturesUnavailableError,
    GraphicalEnvironmentNotFoundError,

    // OAuth
    startOAuthCallbackServer,
    DEFAULT_OAUTH_CALLBACK_PATH,
    buildLoopbackRedirectUri,
    readRedirectUriOverride,
    exchangeCodeForTokens,
    refreshAccessToken,
    generateCodeVerifier,
    generateCodeChallenge,
    OAuthTokenExchangeError,
    OAuthCallbackServerTimeoutError,

    // curl
    runCurlCapturedAsync: runCapturedAsync,
  });
}

export type LatchkeySdk = ReturnType<typeof createLatchkeySdk>;

// ─── Types for plugin authors ─────────────────────────────────────────────────

export type { LatchkeyPlugin, LatchkeyPluginFactory } from './plugins.js';

export type {
  Service,
  ServiceSession,
  SimpleServiceSession,
  BrowserFollowupServiceSession,
  LoginResult,
  ManualCredentialForm,
} from './services/core/base.js';
export type { RegisteredService, RegisteredServiceOptions } from './services/core/registered.js';
export type { LoginFlow } from './services/core/loginFlows/base.js';
export type { GoogleService } from './services/google/base.js';

export type {
  ApiCredentials,
  ApiCredentialsType,
  AuthorizationBare,
  AuthorizationBearer,
  OAuthCredentials,
  RawCurlCredentials,
  SerializedApiCredentials,
} from './apiCredentials/base.js';
export type { EncryptedStorage } from './encryptedStorage.js';

export type {
  BrowserLaunchOptions,
  BrowserWithContext,
  CredentialFormDecision,
  CredentialFormField,
  CredentialFormValues,
  CredentialRequest,
} from './playwrightUtils.js';
export type {
  OAuthCallbackServer,
  OAuthTokenExchangeResponse,
  OAuthTokenResponse,
} from './oauthUtils.js';
export type { CurlResult } from './curl.js';

// What sessions receive from the browser, and the schema builder, so a plugin
// can annotate its code without depending on playwright or zod itself.
export type { Browser, BrowserContext, Locator, Page, Response } from 'playwright';
export type { z } from 'zod';
