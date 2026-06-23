/**
 * Base classes and interfaces for service implementations.
 */

import type { Browser, BrowserContext, Page, Response } from 'playwright';
import type { z, ZodTypeAny } from 'zod';
import {
  ApiCredentialStatus,
  ApiCredentials,
  ApiCredentialsUsageError,
} from '../../apiCredentials/base.js';
import { runCaptured } from '../../curl.js';
import { EncryptedStorage } from '../../encryptedStorage.js';
import {
  generateLatchkeyAppName,
  showSpinnerPage,
  withTempBrowserContext,
  type BrowserLaunchOptions,
} from '../../playwrightUtils.js';

export class NoCurlCredentialsNotSupportedError extends Error {
  constructor(serviceName: string) {
    super(`Service '${serviceName}' does not support set-nocurl credentials.`);
    this.name = 'NoCurlCredentialsNotSupportedError';
  }
}

export class LoginCancelledError extends Error {
  constructor(message = 'Login was cancelled because the browser was closed.') {
    super(message);
    this.name = 'LoginCancelledError';
  }
}

export class LoginFailedError extends Error {
  constructor(message = 'Login failed: no credentials were extracted.') {
    super(message);
    this.name = 'LoginFailedError';
  }
}

/**
 * Thrown when `latchkey auth prepare` is run for a service that does not declare a
 * prepare schema (the base default — services opt in by setting one).
 */
export class PrepareNotSupportedError extends Error {
  constructor(serviceName: string) {
    super(
      `Service '${serviceName}' does not support 'latchkey auth prepare'. ` +
        `Use 'latchkey services info ${serviceName}' to see how to authenticate.`
    );
    this.name = 'PrepareNotSupportedError';
  }
}

/**
 * Thrown when the JSON passed to `latchkey auth prepare` is malformed or does not
 * match the service's prepare schema. The whole command is rejected and
 * nothing is stored.
 */
export class PrepareInputInvalidError extends Error {
  constructor(serviceName: string, detail: string) {
    super(`Invalid prepare input for '${serviceName}': ${detail}`);
    this.name = 'PrepareInputInvalidError';
  }
}

/**
 * Validate a parsed JSON value against a service's prepare schema and build the
 * resulting credentials. Centralizes validation so each service's
 * `prepareFromJson` only expresses its schema and build step. Throws
 * `PrepareInputInvalidError` (with the failing fields) on any schema mismatch;
 * nothing is built unless the input fully validates.
 */
export function buildPreparedCredentials<Schema extends ZodTypeAny>(
  serviceName: string,
  schema: Schema,
  parsedJson: unknown,
  build: (validatedInput: z.infer<Schema>) => ApiCredentials
): ApiCredentials {
  const result = schema.safeParse(parsedJson);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => {
        const path = issue.path.join('.');
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join('; ');
    throw new PrepareInputInvalidError(serviceName, detail);
  }
  return build(result.data as z.infer<Schema>);
}

export function isBrowserClosedError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('target closed') ||
    message.includes('browser closed') ||
    message.includes('browser has been closed') ||
    message.includes('context has been closed') ||
    message.includes('page has been closed') ||
    message.includes('net::err_aborted')
  );
}

export function isTimeoutError(error: Error): boolean {
  return error.name === 'TimeoutError';
}

/**
 * Abstract base class for services that latchkey can authenticate with.
 */
export abstract class Service {
  abstract readonly name: string;
  abstract readonly displayName: string;
  abstract readonly baseApiUrls: readonly (string | RegExp)[];
  abstract readonly loginUrl: string;

  /**
   * Developer notes about this service for agents and users.
   */
  abstract readonly info: string;

  /**
   * Return curl arguments for checking credentials (excluding auth headers).
   */
  abstract readonly credentialCheckCurlArguments: readonly string[];

  /**
   * Optionally transform the stored credentials before they are injected into a
   * curl call, based on the request URL. Services can override this to use a
   * different credential form for different kinds of URLs (e.g. API access vs.
   * repository access). Implementations should throw if the stored credentials
   * are not of the expected type.
   */
  adjustCredentials?(apiCredentials: ApiCredentials, url: string): ApiCredentials;

  /**
   * Check if the given API credentials are valid for this service.
   */
  async checkApiCredentials(apiCredentials: ApiCredentials): Promise<ApiCredentialStatus> {
    let allCurlArgs: readonly string[];
    try {
      allCurlArgs = await apiCredentials.injectIntoCurlCall([
        '-s',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        ...this.credentialCheckCurlArguments,
      ]);
    } catch (error) {
      if (error instanceof ApiCredentialsUsageError) {
        return ApiCredentialStatus.Missing;
      }
      throw error;
    }

    const result = runCaptured(allCurlArgs, 10);

    if (result.stdout === '200') {
      return ApiCredentialStatus.Valid;
    }
    return ApiCredentialStatus.Invalid;
  }

  /**
   * Return an example showing how to set credentials for this service via the CLI.
   * The service name is passed as a parameter (not baked in) so the same example
   * can be reused for aliased services in the future.
   */
  abstract setCredentialsExample(serviceName: string): string;

  /**
   * Set credentials from arbitrary (non-curl) arguments.
   * Services that support this should override to validate and return typed credentials.
   */
  getCredentialsNoCurl(_arguments: readonly string[]): ApiCredentials {
    throw new NoCurlCredentialsNotSupportedError(this.name);
  }

  /**
   * Build credentials from a parsed JSON payload for `latchkey auth prepare`.
   *
   * Optional, like `getSession`/`refreshCredentials`: services opt in by
   * implementing it (typically via `buildPreparedCredentials` with a Zod
   * schema). When a service does not implement it, prepare is "not supported"
   * — the default that lets every service stay closed until it declares a
   * schema. Implementations validate `parsedJson` and throw
   * `PrepareInputInvalidError` on mismatch.
   */
  prepareFromJson?(parsedJson: unknown): ApiCredentials;

  /**
   * Get a new session for the login flow.
   * Services that don't support browser login should not implement this method.
   * @param appNamePrefix - Prefix to use for app/project/token names created during login.
   */
  getSession?(appNamePrefix: string): ServiceSession;

  /**
   * Optional method to refresh expired credentials.
   * Services can implement this to refresh access tokens without user interaction.
   * @param apiCredentials - The expired credentials
   * @returns New credentials if refresh succeeded, null otherwise
   */
  refreshCredentials?(apiCredentials: ApiCredentials): Promise<ApiCredentials | null>;
}

/**
 * Base class for service sessions that handle browser-based interactions.
 * This includes login, preparation steps, and any other browser automation.
 */
export abstract class ServiceSession {
  readonly service: Service;
  protected readonly appNamePrefix: string;

  constructor(service: Service, appNamePrefix: string) {
    this.service = service;
    this.appNamePrefix = appNamePrefix;
  }

  /**
   * Generate a random, unique app name using the session's configured prefix.
   */
  protected generateAppName(suffix?: string): string {
    return generateLatchkeyAppName(this.appNamePrefix, suffix);
  }

  /**
   * Handle a response during the headful login phase.
   */
  abstract onResponse(response: Response): void;

  /**
   * Check if the login phase is complete.
   */
  protected abstract isLoginComplete(): boolean;

  /**
   * Finalize credentials after the headful login phase.
   * Receives the browser and context from the login phase, which are still open.
   * @param browser - Browser instance
   * @param context - Browser context
   * @param oldCredentials - Optional existing credentials to reuse
   */
  protected abstract finalizeCredentials(
    browser: Browser,
    context: BrowserContext,
    oldCredentials?: ApiCredentials
  ): Promise<ApiCredentials | null>;

  /**
   * Wait until the browser login phase is complete.
   */
  private async waitForLoginComplete(page: Page): Promise<void> {
    while (!this.isLoginComplete()) {
      await page.waitForTimeout(100);
    }
  }

  /**
   * Optionally diagnose a timeout error that occurred during credential finalization.
   *
   * Services can override this to inspect the page state and return a more
   * specific error (e.g., checking for permission denied messages).
   * If this returns an error, it will be thrown instead of the generic
   * LoginFailedError. If it returns null, the original timeout error message is used.
   */
  protected diagnoseTimeoutError(
    _context: BrowserContext,
    _originalError: Error
  ): Promise<Error | null> {
    return Promise.resolve(null);
  }

  /**
   * Optional preparation step before login.
   * Services can override this to perform setup (e.g., creating OAuth clients).
   */
  prepare?(
    encryptedStorage: EncryptedStorage,
    launchOptions?: BrowserLaunchOptions
  ): Promise<ApiCredentials>;

  /**
   * Perform the login flow and return the extracted credentials.
   * @param encryptedStorage - Storage for managing credentials
   * @param launchOptions - Browser launch options
   * @param oldCredentials - Optional existing credentials to reuse (e.g., client ID/secret)
   */
  async login(
    encryptedStorage: EncryptedStorage,
    launchOptions: BrowserLaunchOptions = {},
    oldCredentials?: ApiCredentials
  ): Promise<ApiCredentials> {
    return withTempBrowserContext(encryptedStorage, launchOptions, async ({ browser, context }) => {
      const page = await context.newPage();

      context.on('response', (response) => {
        this.onResponse(response);
      });

      try {
        await page.goto(this.service.loginUrl);
        await this.waitForLoginComplete(page);
      } catch (error: unknown) {
        if (error instanceof Error && isBrowserClosedError(error)) {
          throw new LoginCancelledError();
        }
        throw error;
      }

      let apiCredentials: ApiCredentials | null;
      try {
        apiCredentials = await this.finalizeCredentials(browser, context, oldCredentials);
      } catch (error: unknown) {
        if (error instanceof Error && isBrowserClosedError(error)) {
          throw new LoginCancelledError();
        }
        if (error instanceof Error && isTimeoutError(error)) {
          const diagnosedError = await this.diagnoseTimeoutError(context, error);
          if (diagnosedError !== null) {
            throw diagnosedError;
          }
          throw new LoginFailedError(`Login failed: ${error.message}`);
        }
        throw error;
      }

      if (apiCredentials === null) {
        throw new LoginFailedError();
      }

      return apiCredentials;
    });
  }
}

/**
 * Simple service session where credentials are extracted by observing requests during login.
 */
export abstract class SimpleServiceSession extends ServiceSession {
  protected apiCredentials: ApiCredentials | null = null;

  /**
   * Extract API credentials from a response during the headful login phase.
   */
  protected abstract getApiCredentialsFromResponse(
    response: Response
  ): Promise<ApiCredentials | null>;

  onResponse(response: Response): void {
    if (this.apiCredentials !== null) {
      return;
    }
    this.getApiCredentialsFromResponse(response)
      .then((credentials) => {
        if (this.apiCredentials === null && credentials !== null) {
          this.apiCredentials = credentials;
        }
      })
      .catch(() => {
        // Ignore errors extracting credentials
      });
  }

  protected isLoginComplete(): boolean {
    return this.apiCredentials !== null;
  }

  protected finalizeCredentials(
    _browser: Browser,
    _context: BrowserContext,
    _oldCredentials?: ApiCredentials
  ): Promise<ApiCredentials | null> {
    return Promise.resolve(this.apiCredentials);
  }
}

/**
 * Service session that requires a browser followup to finalize credentials.
 *
 * The login phase captures login state. After login completes,
 * the same browser session is reused to perform additional actions
 * (e.g., navigating to settings and creating an API key).
 */
export abstract class BrowserFollowupServiceSession extends ServiceSession {
  /**
   * Perform actions in the browser to finalize and extract API credentials.
   * This runs in the same browser session used for login.
   * @param context - Browser context
   * @param oldCredentials - Optional existing credentials to reuse
   */
  protected abstract performBrowserFollowup(
    context: BrowserContext,
    oldCredentials?: ApiCredentials
  ): Promise<ApiCredentials | null>;

  protected override async finalizeCredentials(
    _browser: Browser,
    context: BrowserContext,
    oldCredentials?: ApiCredentials
  ): Promise<ApiCredentials | null> {
    await showSpinnerPage(context, `Finalizing ${this.service.displayName} login...`);
    return this.performBrowserFollowup(context, oldCredentials);
  }
}
