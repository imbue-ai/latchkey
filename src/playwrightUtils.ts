/**
 * Playwright utility functions for browser automation.
 */

export class BrowserDisabledError extends Error {
  constructor() {
    super('Browser is disabled via LATCHKEY_DISABLE_BROWSER environment variable.');
    this.name = 'BrowserDisabledError';
  }
}

export class GraphicalEnvironmentNotFoundError extends Error {
  constructor() {
    super(
      'No graphical environment detected (neither DISPLAY nor WAYLAND_DISPLAY is set). ' +
        'Browser-based authentication requires a graphical environment.'
    );
    this.name = 'GraphicalEnvironmentNotFoundError';
  }
}

/**
 * Check whether a graphical environment is available.
 * On Linux, this requires DISPLAY or WAYLAND_DISPLAY to be set.
 * On other platforms (macOS, Windows), a display is assumed to be available.
 */
export function hasGraphicalEnvironment(): boolean {
  if (process.platform !== 'linux') {
    return true;
  }
  const display = process.env.DISPLAY;
  const waylandDisplay = process.env.WAYLAND_DISPLAY;
  return (
    (display !== undefined && display !== '') ||
    (waylandDisplay !== undefined && waylandDisplay !== '')
  );
}

export class BrowserFlowsNotSupportedError extends Error {
  constructor(serviceName: string, authSubcommand: 'set' | 'set-nocurl' = 'set') {
    super(
      `Service '${serviceName}' does not support browser flows. Use 'latchkey auth ${authSubcommand} ${serviceName}' to set credentials manually.`
    );
    this.name = 'BrowserFlowNotSupportedError';
  }
}

import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page, Locator, LaunchOptions } from 'playwright';
import { chromium } from 'playwright';
import { EncryptedStorage } from './encryptedStorage.js';

export interface BrowserWithContext {
  readonly browser: Browser;
  readonly context: BrowserContext;
}

export interface BrowserLaunchOptions {
  /** Path to the browser executable. If not provided, Playwright's default is used. */
  executablePath?: string;
  /** Path to the encrypted browser state file for persisting cookies/storage. */
  browserStatePath?: string;
}

/**
 * Generate a random Latchkey-prefixed app name.
 * Used for creating unique names when registering API keys, apps, or tokens.
 */
export function generateLatchkeyAppName(suffix?: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const randomSuffix = randomUUID().slice(0, 4);
  return `Latchkey-${date}-${randomSuffix}${suffix ?? ''}`;
}

/**
 * Run a callback with a browser context initialized from encrypted storage state.
 * After the callback completes, persists browser state back to encrypted storage.
 */
export async function withTempBrowserContext<T>(
  encryptedStorage: EncryptedStorage,
  options: BrowserLaunchOptions,
  callback: (state: BrowserWithContext) => Promise<T>
): Promise<T> {
  const tempDir = mkdtempSync(join(tmpdir(), 'latchkey-browser-state-'));
  const tempFilePath = join(tempDir, 'browser_state.json');

  let initialStorageState: string | undefined;
  if (options.browserStatePath && existsSync(options.browserStatePath)) {
    const content = encryptedStorage.readFile(options.browserStatePath);
    if (content !== null) {
      writeFileSync(tempFilePath, content, { encoding: 'utf-8', mode: 0o600 });
      initialStorageState = tempFilePath;
    }
  }

  const playwrightLaunchOptions: LaunchOptions = { headless: false };
  if (options.executablePath) {
    playwrightLaunchOptions.executablePath = options.executablePath;
  }
  const browser = await chromium.launch(playwrightLaunchOptions);

  try {
    const contextOptions: { storageState?: string } = {
      storageState: initialStorageState,
    };
    const context = await browser.newContext(contextOptions);

    const result = await callback({ browser, context });

    // Persist browser state back to encrypted storage
    if (options.browserStatePath) {
      await context.storageState({ path: tempFilePath });
      const content = readFileSync(tempFilePath, 'utf-8');
      encryptedStorage.writeFile(options.browserStatePath, content);
    }

    return result;
  } finally {
    await browser.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

// Typing delay range in milliseconds (min, max) to simulate human-like typing
const TYPING_DELAY_MIN_MS = 30;
const TYPING_DELAY_MAX_MS = 100;

/**
 * Type text character by character with random delays to simulate human typing.
 *
 * This triggers proper JavaScript input events that some websites require,
 * unlike fill() which sets the value directly.
 */
export async function typeLikeHuman(page: Page, locator: Locator, text: string): Promise<void> {
  await locator.click();
  for (const character of text) {
    await locator.pressSequentially(character);
    const delay =
      Math.floor(Math.random() * (TYPING_DELAY_MAX_MS - TYPING_DELAY_MIN_MS + 1)) +
      TYPING_DELAY_MIN_MS;
    await page.waitForTimeout(delay);
  }
}

// Script that creates the spinner overlay, designed to run in browser context
function createSpinnerOverlayScript(message: string): string {
  return `
(() => {
  if (document.getElementById('latchkey-spinner-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'latchkey-spinner-overlay';
  overlay.innerHTML = \`
    <style>
      #latchkey-spinner-overlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: #f5f5f5;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        pointer-events: none;
      }
      #latchkey-spinner-overlay .spinner {
        width: 50px;
        height: 50px;
        border: 4px solid #e0e0e0;
        border-top-color: #007bff;
        border-radius: 50%;
        animation: latchkey-spin 1s linear infinite;
      }
      #latchkey-spinner-overlay .message {
        margin-top: 20px;
        color: #555;
        font-size: 16px;
        text-align: center;
        max-width: 80%;
        white-space: pre-line;
      }
      @keyframes latchkey-spin {
        to { transform: rotate(360deg); }
      }
    </style>
    <div class="spinner"></div>
    <div class="message">${message}</div>
  \`;
  document.body.appendChild(overlay);
})()
`;
}

/**
 * Show a spinner overlay that hides page content from the user.
 * The overlay persists across page navigations within the browser context.
 *
 * Can be disabled by setting LATCHKEY_DISABLE_SPINNER=1 environment variable.
 */
export async function showSpinnerPage(context: BrowserContext, message: string): Promise<void> {
  if (process.env.LATCHKEY_DISABLE_SPINNER === '1') {
    return;
  }
  const spinnerPage = await context.newPage();
  await spinnerPage.evaluate(createSpinnerOverlayScript(message));
  await spinnerPage.bringToFront();
}
