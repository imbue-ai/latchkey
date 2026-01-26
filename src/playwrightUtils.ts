/**
 * Playwright utility functions for browser automation.
 */

import type { BrowserContext, CDPSession, Page, Locator } from 'playwright';

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

/**
 * Minimize the browser window using CDP.
 * Only works for Chromium-based browsers.
 */
export async function minimizeBrowserWindow(context: BrowserContext): Promise<void> {
  const page = context.pages()[0];
  if (!page) {
    return;
  }

  let cdpSession: CDPSession | null = null;
  try {
    cdpSession = await context.newCDPSession(page);
    const { windowId } = await cdpSession.send('Browser.getWindowForTarget');
    await cdpSession.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'minimized' },
    });
  } catch {
    // Silently ignore if CDP is not available (e.g., non-Chromium browsers)
  } finally {
    if (cdpSession) {
      await cdpSession.detach();
    }
  }
}
