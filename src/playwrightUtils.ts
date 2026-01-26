/**
 * Playwright utility functions for browser automation.
 */

import type { BrowserContext, Page, Locator } from 'playwright';

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
const SPINNER_OVERLAY_SCRIPT = `
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
    <div class="message">Finalizing credentials...</div>
  \`;
  document.body.appendChild(overlay);
})()
`;

/**
 * Show a spinner overlay that hides page content from the user.
 * The overlay persists across page navigations within the browser context.
 */
export async function showSpinnerPage(context: BrowserContext): Promise<void> {
  const spinnerPage = await context.newPage();
  await spinnerPage.evaluate(SPINNER_OVERLAY_SCRIPT);
  await spinnerPage.bringToFront();
}
