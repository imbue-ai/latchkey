/**
 * The browser a loopback OAuth login sends the user to.
 *
 * Such a login (the remote MCP servers, the Google services, Fastmail, Ramp)
 * needs nothing of the browser but to show the authorization URL: the code
 * comes back to a loopback server Latchkey runs itself, and the tokens are
 * fetched with curl. So the browser can be either the one Latchkey drives
 * through Playwright, or the system browser (`LoginOptions.systemBrowser`).
 * This module hides which, and is what lets those sessions declare
 * `supportsSystemBrowser`.
 */

import type { EncryptedStorage } from '../../encryptedStorage.js';
import { withTempBrowserContext, type BrowserLaunchOptions } from '../../playwrightUtils.js';
import { openInSystemBrowser } from '../../systemBrowser.js';
import { isBrowserClosedError, LoginCancelledError, type LoginOptions } from './base.js';

export interface OAuthLoginBrowser {
  /** Show the user the given page. Resolves once the browser has been told to load it. */
  open(url: string): Promise<void>;
  /**
   * Aborted when the user closes the browser, so that a wait on the loopback
   * server can end early. The system browser gives no such signal, so there a
   * login the user abandons ends only when it times out.
   */
  readonly closeSignal: AbortSignal;
}

const NEVER_ABORTED = new AbortController().signal;

/**
 * Run `callback` with a browser to open the authorization URL in, and clean up
 * afterwards. A closed Playwright browser surfaces as `LoginCancelledError`.
 */
export async function withOAuthLoginBrowser<T>(
  encryptedStorage: EncryptedStorage,
  launchOptions: BrowserLaunchOptions,
  loginOptions: LoginOptions,
  callback: (browser: OAuthLoginBrowser) => Promise<T>
): Promise<T> {
  if (loginOptions.systemBrowser === true) {
    return callback({ open: openInSystemBrowser, closeSignal: NEVER_ABORTED });
  }

  return withTempBrowserContext(encryptedStorage, launchOptions, async ({ context }) => {
    const page = await context.newPage();

    const abortController = new AbortController();
    const closeHandler = () => {
      abortController.abort();
    };
    page.on('close', closeHandler);
    context.on('close', closeHandler);

    try {
      const result = await callback({
        open: async (url) => {
          await page.goto(url, { waitUntil: 'domcontentloaded' });
        },
        closeSignal: abortController.signal,
      });
      await page.close();
      return result;
    } catch (error: unknown) {
      if (error instanceof Error && isBrowserClosedError(error)) {
        throw new LoginCancelledError();
      }
      throw error;
    } finally {
      page.off('close', closeHandler);
      context.off('close', closeHandler);
    }
  });
}
