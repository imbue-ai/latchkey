/**
 * Base classes and interfaces for service implementations.
 */

import type { Browser, BrowserContext, Page, Response } from 'playwright';
import { ApiCredentialStatus, ApiCredentials } from '../apiCredentials.js';
import { BrowserStateStore } from '../browserState.js';
import { EncryptedStorage } from '../encryptedStorage.js';
import { showSpinnerPage } from '../playwrightUtils.js';

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
 * Base interface for a service that latchkey can authenticate with.
 */
export interface Service {
  readonly name: string;
  readonly baseApiUrls: readonly string[];
  readonly loginUrl: string;
  readonly loginInstructions: readonly string[] | null;

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
   * Check if the headful login phase is complete.
   */
  protected abstract isHeadfulLoginComplete(): boolean;

  /**
   * Finalize credentials after the headful login phase.
   * Receives the browser and context from the login phase, which are still open.
   */
  protected abstract finalizeCredentials(
    browser: Browser,
    context: BrowserContext
  ): Promise<ApiCredentials | null>;

  /**
   * Wait until the headful browser login phase is complete.
   */
  protected async waitForHeadfulLoginComplete(page: Page): Promise<void> {
    while (!this.isHeadfulLoginComplete()) {
      await page.waitForTimeout(100);
    }
  }

  /**
   * Show login instructions to the user before redirecting to the login page.
   */
  protected async showLoginInstructions(page: Page): Promise<void> {
    const instructions = this.service.loginInstructions;
    if (instructions === null) {
      return;
    }

    const instructionsList = instructions.map((item) => `<li>${item}</li>`).join('\n');

    const instructionsHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Latchkey - Login Instructions</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 100vh;
          margin: 0;
          background: #f5f5f5;
        }
        .container {
          background: white;
          padding: 40px;
          border-radius: 8px;
          box-shadow: 0 2px 10px rgba(0,0,0,0.1);
          max-width: 500px;
        }
        h1 {
          margin-top: 0;
          color: #333;
        }
        ul {
          line-height: 1.8;
          color: #555;
        }
        button {
          background: #007bff;
          color: white;
          border: none;
          padding: 12px 24px;
          font-size: 16px;
          border-radius: 4px;
          cursor: pointer;
          margin-top: 20px;
        }
        button:hover {
          background: #0056b3;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Log in to ${this.service.name}</h1>
        <ul>
          ${instructionsList}
        </ul>
        <button onclick="window.loginContinue = true">Continue to Login</button>
      </div>
    </body>
    </html>
    `;
    await page.setContent(instructionsHtml);
    await page.waitForFunction('window.loginContinue === true');
  }

  /**
   * Called after headful login completes but before the browser closes.
   */
  protected async onHeadfulLoginComplete(_context: BrowserContext): Promise<void> {
    // Default implementation does nothing
  }

  /**
   * Perform the login flow and return the extracted credentials.
   */
  async login(
    browserStatePath: string | null,
    encryptedStorage: EncryptedStorage
  ): Promise<ApiCredentials> {
    const { chromium: chromiumBrowser } = await import('playwright');
    const browser = await chromiumBrowser.launch({ headless: false });

    // Use BrowserStateStore for encrypted browser state handling
    let browserStateManager: BrowserStateStore | null = null;
    const contextOptions: { storageState?: string } = {};

    if (browserStatePath) {
      browserStateManager = new BrowserStateStore(browserStatePath, encryptedStorage);
      const tempPath = browserStateManager.prepare();
      if (browserStateManager.hasState()) {
        contextOptions.storageState = tempPath;
      }
    }

    try {
      const context = await browser.newContext(contextOptions);
      const page = await context.newPage();

      page.on('response', (response) => {
        this.onResponse(response);
      });

      try {
        // await this.showLoginInstructions(page);
        await page.goto(this.service.loginUrl);
        await this.waitForHeadfulLoginComplete(page);
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          (error.message.includes('Target closed') || error.message.includes('Browser closed'))
        ) {
          throw new LoginCancelledError();
        }
        throw error;
      }

      if (browserStateManager) {
        const tempPath = browserStateManager.getTempPath();
        if (tempPath) {
          await context.storageState({ path: tempPath });
          browserStateManager.persist();
        }
      }

      await this.onHeadfulLoginComplete(context);

      try {
        const apiCredentials = await this.finalizeCredentials(browser, context);

        if (apiCredentials === null) {
          throw new LoginFailedError();
        }

        return apiCredentials;
      } finally {
        await browser.close();
      }
    } finally {
      if (browserStateManager) {
        browserStateManager.cleanup();
      }
    }
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

  protected isHeadfulLoginComplete(): boolean {
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
 * The headful login phase captures login state. After login completes,
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
