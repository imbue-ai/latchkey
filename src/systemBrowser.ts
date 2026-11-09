/**
 * Opening a URL in the system browser: whatever the operating system opens
 * URLs with, as opposed to the browser Latchkey drives through Playwright.
 *
 * This is all a loopback OAuth login needs of a browser (see
 * `withOAuthLoginBrowser`), so such a login can skip `ensure-browser` and the
 * bundled browser altogether. The price is that Latchkey learns nothing about
 * what happens in that browser, not even that it was closed.
 */

import { spawn } from 'node:child_process';
import { LoginFailedError } from './services/core/base.js';

/** A login failure like any other to the callers, so that they report it as one. */
export class SystemBrowserOpenError extends LoginFailedError {
  constructor(command: string, cause: Error) {
    super(`Failed to open the system browser with '${command}': ${cause.message}`);
    this.name = 'SystemBrowserOpenError';
  }
}

export interface SystemBrowserCommand {
  readonly command: string;
  readonly args: readonly string[];
  /**
   * Whether `args` are passed to the command verbatim rather than quoted by
   * Node. Only `cmd.exe` needs this: its `start` built-in has its own quoting
   * rules, so the arguments are composed for it by hand.
   */
  readonly verbatimArguments: boolean;
}

/**
 * The command each platform opens URLs with. Exported for the tests; callers
 * use {@link openInSystemBrowser}.
 */
export function buildSystemBrowserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform
): SystemBrowserCommand {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [url], verbatimArguments: false };
    case 'win32':
      // `start` takes its first quoted argument as a window title, hence the
      // empty one. Quoting the URL keeps cmd.exe from reading `&` in the query
      // string as a command separator.
      return {
        command: 'cmd.exe',
        args: ['/c', 'start', '""', `"${url}"`],
        verbatimArguments: true,
      };
    default:
      return { command: 'xdg-open', args: [url], verbatimArguments: false };
  }
}

/**
 * Open the URL in the system browser and return once the opener has been
 * handed the URL. The opener is left to itself after that: it exits as soon
 * as the browser has taken over, and a browser that fails to start past that
 * point is beyond what can be observed from here.
 */
export function openInSystemBrowser(url: string): Promise<void> {
  const { command, args, verbatimArguments } = buildSystemBrowserCommand(url);
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], {
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: verbatimArguments,
    });
    child.once('error', (error) => {
      reject(new SystemBrowserOpenError(command, error));
    });
    child.once('spawn', () => {
      // Let the process exit without waiting for the opener.
      child.unref();
      resolve();
    });
  });
}
