/**
 * Base classes and interfaces for service implementations.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import type { BrowserContext, Page, Response, BrowserType } from 'playwright';
import { ApiCredentialStatus, ApiCredentials } from '../apiCredentials.js';

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
   * May launch a headless browser for additional actions.
   */
  protected abstract finalizeCredentials(chromium: BrowserType): Promise<ApiCredentials | null>;

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
  async login(browserStatePath: string | null): Promise<ApiCredentials> {
    const { chromium: chromiumBrowser } = await import('playwright');
    const browser = await chromiumBrowser.launch({ headless: false });

    const contextOptions: { storageState?: string } = {};
    if (browserStatePath && existsSync(browserStatePath)) {
      contextOptions.storageState = browserStatePath;
    }
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    page.on('response', (response) => {
      this.onResponse(response);
    });

    try {
      await this.showLoginInstructions(page);
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

    if (browserStatePath) {
      await context.storageState({ path: browserStatePath });
    }

    await this.onHeadfulLoginComplete(context);
    await browser.close();

    const apiCredentials = await this.finalizeCredentials(chromiumBrowser);

    if (apiCredentials === null) {
      throw new LoginFailedError();
    }

    return apiCredentials;
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
  protected abstract getApiCredentialsFromResponse(response: Response): ApiCredentials | null;

  onResponse(response: Response): void {
    if (this.apiCredentials !== null) {
      return;
    }
    this.apiCredentials = this.getApiCredentialsFromResponse(response);
  }

  protected isHeadfulLoginComplete(): boolean {
    return this.apiCredentials !== null;
  }

  protected finalizeCredentials(_chromium: BrowserType): Promise<ApiCredentials | null> {
    return Promise.resolve(this.apiCredentials);
  }
}

/**
 * Service session that requires a headless browser followup to finalize credentials.
 *
 * The headful login phase captures login state. After the headful browser closes,
 * a headless browser is launched with the same state to perform additional actions
 * (e.g., navigating to settings and creating an API key).
 */
export abstract class BrowserFollowupServiceSession extends ServiceSession {
  protected temporaryStatePath: string | null = null;
  private temporaryDirectory: string | null = null;

  /**
   * Perform actions in a headless browser to finalize and extract API credentials.
   */
  protected abstract performBrowserFollowup(
    context: BrowserContext
  ): Promise<ApiCredentials | null>;

  override async login(browserStatePath: string | null): Promise<ApiCredentials> {
    // Create temporary directory for browser state
    this.temporaryDirectory = mkdtempSync(join(tmpdir(), 'latchkey-'));
    this.temporaryStatePath = join(this.temporaryDirectory, 'browser_state.json');

    try {
      return await super.login(browserStatePath);
    } finally {
      // Clean up temporary directory
      if (this.temporaryDirectory) {
        rmSync(this.temporaryDirectory, { recursive: true, force: true });
      }
    }
  }

  protected override async onHeadfulLoginComplete(context: BrowserContext): Promise<void> {
    if (this.temporaryStatePath !== null) {
      await context.storageState({ path: this.temporaryStatePath });
    }
  }

  protected override async finalizeCredentials(
    chromium: BrowserType
  ): Promise<ApiCredentials | null> {
    if (this.temporaryStatePath === null || !existsSync(this.temporaryStatePath)) {
      return null;
    }

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      storageState: this.temporaryStatePath,
    });

    try {
      const apiCredentials = await this.performBrowserFollowup(context);
      return apiCredentials;
    } catch (error: unknown) {
      if (error instanceof LoginFailedError) {
        throw error;
      }
      throw new LoginFailedError(
        `Login failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      await browser.close();
    }
  }
}
