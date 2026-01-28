/**
 * Playwright utility functions for browser automation.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page, Locator } from 'playwright';
import { EncryptedStorage } from './encryptedStorage.js';

export interface BrowserWithContext {
  readonly browser: Browser;
  readonly context: BrowserContext;
}

/**
 * Run a callback with a browser context initialized from encrypted storage state.
 * After the callback completes, persists browser state back to encrypted storage.
 */
export async function withTempBrowserContext<T>(
  encryptedStorage: EncryptedStorage,
  browserStatePath: string,
  callback: (state: BrowserWithContext) => Promise<T>
): Promise<T> {
  const tempDir = mkdtempSync(join(tmpdir(), 'latchkey-browser-state-'));
  const tempFilePath = join(tempDir, 'browser_state.json');

  let initialStorageState: string | undefined;
  const actualPath = encryptedStorage.getActualPath(browserStatePath);
  if (existsSync(actualPath)) {
    const content = encryptedStorage.readFile(browserStatePath);
    if (content !== null) {
      writeFileSync(tempFilePath, content, { encoding: 'utf-8', mode: 0o600 });
      initialStorageState = tempFilePath;
    }
  }

  const { chromium: chromiumBrowser } = await import('playwright');
  const browser = await chromiumBrowser.launch({ headless: false });

  try {
    const contextOptions: { storageState?: string } = {};
    if (initialStorageState !== undefined) {
      contextOptions.storageState = initialStorageState;
    }
    const context = await browser.newContext(contextOptions);

    const result = await callback({ browser, context });

    // Persist browser state back to encrypted storage
    await context.storageState({ path: tempFilePath });
    const content = readFileSync(tempFilePath, 'utf-8');
    encryptedStorage.writeFile(browserStatePath, content);

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
function createSpinnerOverlayScript(serviceName: string): string {
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
      }
      @keyframes latchkey-spin {
        to { transform: rotate(360deg); }
      }
    </style>
    <div class="spinner"></div>
    <div class="message">Finalizing ${serviceName} login...</div>
  \`;
  document.body.appendChild(overlay);
})()
`;
}

/**
 * Show a spinner overlay that hides page content from the user.
 * The overlay persists across page navigations within the browser context.
 */
export async function showSpinnerPage(context: BrowserContext, serviceName: string): Promise<void> {
  const spinnerPage = await context.newPage();
  await spinnerPage.evaluate(createSpinnerOverlayScript(serviceName));
  await spinnerPage.bringToFront();
}
