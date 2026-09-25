/**
 * macOS-specific browser launch helpers.
 *
 * On macOS, `chromium.launch()` execs the browser binary as a raw subprocess of
 * the node process. macOS does not register that subprocess with LaunchServices,
 * so System Events cannot see or raise it: the window opens behind the foreground
 * app and never receives keyboard input. These helpers launch the browser as a
 * proper application via `open`/LaunchServices and connect over CDP instead, so
 * the window comes to the front and accepts input.
 */

import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import type { Browser, BrowserType } from 'playwright';

/**
 * Surface a best-effort teardown/cleanup failure on stderr when `LATCHKEY_DEBUG`
 * is set, so the silent catch branches in the browser launch/cleanup path are
 * observable while debugging without noising up normal runs.
 */
export function logBestEffortError(context: string, error: unknown): void {
  if (process.env.LATCHKEY_DEBUG === '1') {
    console.error(`[latchkey] ${context}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Find a free TCP port on the loopback interface by opening a listening socket
 * on port 0 and reading back the assigned port. Used to pick a unique
 * `--remote-debugging-port` for the macOS app-style browser launch.
 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address !== null && typeof address === 'object') {
        const port = address.port;
        server.close(() => {
          resolve(port);
        });
      } else {
        server.close();
        reject(new Error('Could not find a free port.'));
      }
    });
  });
}

/**
 * Derive the macOS `.app` bundle path from a browser executable path, e.g.
 * `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` ->
 * `/Applications/Google Chrome.app`. Falls back to the app name `Google Chrome`
 * (resolved by LaunchServices) when no bundle can be inferred.
 */
export function macOSAppBundlePath(executablePath: string | undefined): string {
  const match = executablePath !== undefined ? /(^.*\.app)\//.exec(executablePath) : null;
  return match?.[1] ?? 'Google Chrome';
}

/**
 * Wait for a Chromium CDP endpoint to answer on the given port, returning the
 * endpoint URL once it is up. Throws if the browser never exposes CDP.
 */
async function waitForCdpEndpoint(port: number): Promise<string> {
  const endpoint = `http://127.0.0.1:${String(port)}`;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) {
        return endpoint;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Browser did not expose a CDP endpoint on port ${String(port)}.`);
}

/**
 * Launch a browser as a proper macOS application via `open`/LaunchServices and
 * connect to it over CDP.
 *
 * Returns the connected browser and a cleanup function that terminates the
 * launched process. `browser.close()` only disconnects a CDP-connected browser;
 * it does not quit the process, so the cleanup kills whatever is listening on
 * the debug port to release the profile. The caller should disconnect via
 * `browser.close()` first.
 */
export async function launchBrowserAsMacApp(
  chromium: BrowserType,
  appBundlePath: string,
  profileDir: string,
  extraArgs: string[]
): Promise<{ browser: Browser; cleanup: () => Promise<void> }> {
  const port = await findFreePort();
  const browserArgs = [
    `--remote-debugging-port=${String(port)}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    ...extraArgs,
  ];
  await new Promise<void>((resolve, reject) => {
    execFile('open', ['-na', appBundlePath, '--args', ...browserArgs], (error) => {
      if (error === null) {
        resolve();
      } else {
        reject(
          new Error(
            `Failed to launch the browser application${error instanceof Error ? `: ${error.message}` : ''}`
          )
        );
      }
    });
  });
  const endpoint = await waitForCdpEndpoint(port);
  const browser = await chromium.connectOverCDP(endpoint);
  const cleanup = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      execFile('lsof', ['-ti', `tcp:${String(port)}`], (_error, stdout) => {
        for (const pid of stdout.trim().split(/\s+/).filter(Boolean)) {
          try {
            process.kill(Number(pid), 'SIGKILL');
          } catch (error) {
            logBestEffortError('failed to kill launched browser process', error);
          }
        }
        resolve();
      });
    });
  };
  return { browser, cleanup };
}
