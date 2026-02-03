/**
 * Direct Playwright browser download implementation.
 *
 * This module downloads Chromium directly without using Playwright's
 * installBrowsersForNpmInstall which uses childProcess.fork() - a mechanism
 * not supported in Bun.
 *
 * We use Playwright's registry to get the correct download URLs and
 * browser directory, then perform the download and extraction ourselves.
 */

import { createWriteStream, existsSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { get as httpsGet, type IncomingMessage } from 'node:https';
import { get as httpGet } from 'node:http';
import { platform } from 'node:os';
import { join, dirname } from 'node:path';
import { registry } from 'playwright-core/lib/server/registry/index';
import { extract } from 'playwright-core/lib/zipBundle';

/**
 * Error thrown when browser download fails.
 */
export class BrowserDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserDownloadError';
  }
}

/**
 * Error thrown when browser extraction fails.
 */
export class BrowserExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserExtractionError';
  }
}

/**
 * Gets the Chromium executable info from Playwright's registry.
 */
export function getChromiumExecutable() {
  const chromiumExecutable = registry.findExecutable('chromium');

  if (!chromiumExecutable) {
    throw new BrowserDownloadError('Could not find Chromium in Playwright registry');
  }

  return chromiumExecutable;
}

/**
 * Downloads a file from a URL to a local path.
 */
export async function downloadFile(url: string, destinationPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https://');
    const getter = isHttps ? httpsGet : httpGet;

    const handleResponse = (response: IncomingMessage) => {
      // Handle redirects
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        const location = response.headers.location;
        if (location) {
          downloadFile(location, destinationPath).then(resolve).catch(reject);
          return;
        }
      }

      if (response.statusCode !== 200) {
        reject(
          new BrowserDownloadError(`Download failed with status ${response.statusCode}: ${url}`)
        );
        return;
      }

      // Ensure directory exists
      const directory = dirname(destinationPath);
      if (!existsSync(directory)) {
        mkdirSync(directory, { recursive: true });
      }

      const fileStream = createWriteStream(destinationPath);

      pipeline(response, fileStream)
        .then(() => resolve())
        .catch((error) => {
          // Clean up partial file
          try {
            unlinkSync(destinationPath);
          } catch {
            // Ignore cleanup errors
          }
          reject(new BrowserDownloadError(`Download failed: ${String(error)}`));
        });
    };

    const request = getter(url, handleResponse);
    request.on('error', (error) => {
      reject(new BrowserDownloadError(`Download request failed: ${String(error)}`));
    });
  });
}

/**
 * Extracts a zip file to a directory using Playwright's internal zip extraction.
 */
export async function extractZip(zipPath: string, destinationDirectory: string): Promise<void> {
  // Ensure destination directory exists
  if (!existsSync(destinationDirectory)) {
    mkdirSync(destinationDirectory, { recursive: true });
  }

  await extract(zipPath, { dir: destinationDirectory });
}

/**
 * Sets executable permissions on the browser binary.
 */
export function setExecutablePermissions(executablePath: string): void {
  if (platform() !== 'win32' && existsSync(executablePath)) {
    chmodSync(executablePath, 0o755);
  }
}

/**
 * Downloads Chromium directly without using Playwright's fork-based mechanism.
 * Returns the path to the browser executable.
 */
export async function downloadChromium(): Promise<string> {
  const chromiumExecutable = getChromiumExecutable();

  const browserDirectory = chromiumExecutable.directory;
  if (!browserDirectory) {
    throw new BrowserDownloadError('Could not determine Chromium installation directory');
  }

  const executablePath = chromiumExecutable.executablePath('javascript');
  if (!executablePath) {
    throw new BrowserDownloadError('Could not determine Chromium executable path');
  }

  const downloadUrls = chromiumExecutable.downloadURLs;
  if (!downloadUrls || downloadUrls.length === 0) {
    throw new BrowserDownloadError('No download URLs available for Chromium');
  }

  const zipPath = join(browserDirectory, 'chromium.zip');

  // Ensure browser directory exists
  mkdirSync(browserDirectory, { recursive: true });

  // Try each URL until one succeeds
  let lastError: Error | null = null;
  for (const url of downloadUrls) {
    try {
      console.log(`Downloading Chromium from ${url}...`);
      await downloadFile(url, zipPath);

      console.log('Extracting Chromium...');
      await extractZip(zipPath, browserDirectory);

      // Clean up zip file
      try {
        unlinkSync(zipPath);
      } catch {
        // Ignore cleanup errors
      }

      // Set executable permissions
      setExecutablePermissions(executablePath);

      console.log(`Chromium downloaded successfully to ${browserDirectory}`);
      return executablePath;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn(`Download attempt failed: ${lastError.message}`);
      // Clean up partial download if it exists
      try {
        if (existsSync(zipPath)) {
          unlinkSync(zipPath);
        }
      } catch {
        // Ignore cleanup errors
      }
      // Try next URL
    }
  }

  throw new BrowserDownloadError(
    `Failed to download Chromium from all mirrors. Last error: ${lastError?.message || 'Unknown error'}`
  );
}
