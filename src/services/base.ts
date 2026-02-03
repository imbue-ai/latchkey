/**
 * Base classes and interfaces for service implementations.
 */

import type { Browser, BrowserContext, Page, Response } from 'playwright';
import { ApiCredentialStatus, ApiCredentials } from '../apiCredentials.js';
import { EncryptedStorage } from '../encryptedStorage.js';
import {
  showSpinnerPage,
  withTempBrowserContext,
  type BrowserLaunchOptions,
} from '../playwrightUtils.js';

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

function isBrowserClosedError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('target closed') ||
    message.includes('browser closed') ||
    message.includes('browser has been closed') ||
    message.includes('context has been closed') ||
    message.includes('page has been closed')
  );
}

function isTimeoutError(error: Error): boolean {
  return error.name === 'TimeoutError';
}

/**
 * Base interface for a service that latchkey can authenticate with.
 */
export interface Service {
  readonly name: string;
  readonly baseApiUrls: readonly string[];
  readonly loginUrl: string;

  /**
   * Check if the given API credentials are valid for this service.
   */
  checkApiCredentials(apiCredentials: ApiCredentials): ApiCredentialStatus;

  /**
   * Return curl arguments for checking credentials (excluding auth headers).
   */
  readonly credentialCheckCurlArguments: readonly string[];

  /**
   * Get a new session for the login flow.
   */
  getSession(): ServiceSession;
}

/**
 * Base class for service sessions that handle the login flow.
 */
export abstract class ServiceSession {
  readonly service: Service;

  constructor(service: Service) {
    this.service = service;
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
   */
  protected abstract finalizeCredentials(
    browser: Browser,
    context: BrowserContext
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
   * Perform the login flow and return the extracted credentials.
   */
  async login(
    encryptedStorage: EncryptedStorage,
    launchOptions: BrowserLaunchOptions = {}
  ): Promise<ApiCredentials> {
    return withTempBrowserContext(encryptedStorage, launchOptions, async ({ browser, context }) => {
      const page = await context.newPage();

      page.on('response', (response) => {
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
        apiCredentials = await this.finalizeCredentials(browser, context);
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
    _context: BrowserContext
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
   */
  protected abstract performBrowserFollowup(
    context: BrowserContext
  ): Promise<ApiCredentials | null>;

  protected override async finalizeCredentials(
    _browser: Browser,
    context: BrowserContext
  ): Promise<ApiCredentials | null> {
    await showSpinnerPage(context, this.service.name);
    return this.performBrowserFollowup(context);
  }
}
