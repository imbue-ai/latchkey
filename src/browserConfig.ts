/**
 * Browser discovery and configuration management for Latchkey.
 *
 * This module handles:
 * - Discovering system-installed Chrome/Chromium browsers
 * - Finding Playwright's bundled Chromium
 * - Downloading Chromium via Playwright when needed
 * - Persisting the discovered browser path
 */

import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { loadBrowserConfig, saveBrowserConfig, type BrowserConfig } from './configDataStore.js';
import { downloadChromium } from './playwrightDownload.js';

/**
 * Browser sources that can be used for discovery.
 */
export const BROWSER_SOURCES = [
  'existing-config',
  'system-browser',
  'existing-playwright-browser',
  'download-playwright-browser',
] as const;

export type BrowserSource = (typeof BROWSER_SOURCES)[number];

/**
 * Default order for browser source discovery.
 */
export const DEFAULT_BROWSER_SOURCES: readonly BrowserSource[] = [
  'existing-config',
  'system-browser',
  'existing-playwright-browser',
  'download-playwright-browser',
];

export class BrowserNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserNotFoundError';
  }
}

export class BrowserConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserConfigError';
  }
}

/**
 * System Chrome/Chromium/Edge installation paths by platform.
 * These are the standard locations where browsers are installed.
 */
const SYSTEM_BROWSER_PATHS: Record<string, readonly string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    '/opt/google/chrome/chrome',
    '/opt/google/chrome-beta/chrome',
    '/opt/google/chrome-unstable/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/microsoft/msedge/msedge',
  ],
  win32: [
    // These are relative paths that will be joined with common Windows prefixes
    '\\Google\\Chrome\\Application\\chrome.exe',
    '\\Google\\Chrome Beta\\Application\\chrome.exe',
    '\\Google\\Chrome SxS\\Application\\chrome.exe',
    '\\Chromium\\Application\\chrome.exe',
    '\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
};

/**
 * Get Windows path prefixes from environment variables.
 */
function getWindowsPrefixes(): string[] {
  const prefixes: string[] = [];
  const env = process.env;

  if (env.LOCALAPPDATA) {
    prefixes.push(env.LOCALAPPDATA);
  }
  if (env.PROGRAMFILES) {
    prefixes.push(env.PROGRAMFILES);
  }
  if (env['PROGRAMFILES(X86)']) {
    prefixes.push(env['PROGRAMFILES(X86)']);
  }
  if (env.HOMEDRIVE) {
    prefixes.push(join(env.HOMEDRIVE, 'Program Files'));
    prefixes.push(join(env.HOMEDRIVE, 'Program Files (x86)'));
  }

  return prefixes;
}

/**
 * Find a system-installed Chrome/Chromium browser.
 * Returns the path to the executable if found, null otherwise.
 */
export function findSystemBrowser(): string | null {
  const currentPlatform = platform();
  const paths = SYSTEM_BROWSER_PATHS[currentPlatform];

  if (!paths) {
    return null;
  }

  if (currentPlatform === 'win32') {
    const prefixes = getWindowsPrefixes();
    for (const prefix of prefixes) {
      for (const suffix of paths) {
        const fullPath = join(prefix, suffix);
        if (existsSync(fullPath)) {
          return fullPath;
        }
      }
    }
  } else {
    for (const path of paths) {
      if (existsSync(path)) {
        return path;
      }
    }
  }

  return null;
}

/**
 * Find Chrome/Chromium installed by Playwright.
 * Returns the path to the executable if found, null otherwise.
 */
export function findPlaywrightBrowser(): string | null {
  const executablePath = chromium.executablePath();
  if (executablePath && existsSync(executablePath)) {
    return executablePath;
  }
  return null;
}

/**
 * Download Chromium using a direct download mechanism.
 *
 * This implementation downloads Chromium without using Playwright's
 * installBrowsersForNpmInstall, which uses childProcess.fork() - a mechanism
 * not supported when Latchkey is compiled with Bun.
 *
 * Returns the path to the downloaded executable.
 */
export async function downloadPlaywrightBrowser(): Promise<string> {
  return downloadChromium();
}

/**
 * Try a single browser source and return the config if successful, null otherwise.
 */
async function tryBrowserSource(
  source: BrowserSource,
  configPath: string
): Promise<BrowserConfig | null> {
  switch (source) {
    case 'existing-config': {
      return loadBrowserConfig(configPath);
    }
    case 'system-browser': {
      const systemPath = findSystemBrowser();
      if (systemPath) {
        return {
          executablePath: systemPath,
          source: 'system',
          discoveredAt: new Date().toISOString(),
        };
      }
      return null;
    }
    case 'existing-playwright-browser': {
      const playwrightPath = findPlaywrightBrowser();
      if (playwrightPath) {
        return {
          executablePath: playwrightPath,
          source: 'playwright',
          discoveredAt: new Date().toISOString(),
        };
      }
      return null;
    }
    case 'download-playwright-browser': {
      const downloadedPath = await downloadPlaywrightBrowser();
      return {
        executablePath: downloadedPath,
        source: 'downloaded',
        discoveredAt: new Date().toISOString(),
      };
    }
  }
}

/**
 * Discover a browser by trying sources in the specified order.
 * Returns the first successful result, or throws if none succeed.
 */
export async function discoverBrowserFromSources(
  sources: readonly BrowserSource[],
  configPath: string
): Promise<{ config: BrowserConfig; source: BrowserSource }> {
  for (const source of sources) {
    const config = await tryBrowserSource(source, configPath);
    if (config) {
      return { config, source };
    }
  }

  throw new BrowserNotFoundError(`No browser found after trying sources: ${sources.join(', ')}`);
}

/**
 * Ensure a browser is available and return its configuration.
 * Tries sources in the specified order, saves the result to the config file.
 */
export async function ensureBrowser(
  configPath: string,
  sources: readonly BrowserSource[] = DEFAULT_BROWSER_SOURCES
): Promise<{ config: BrowserConfig; source: BrowserSource }> {
  const result = await discoverBrowserFromSources(sources, configPath);

  // Save to config file unless we just loaded from existing config
  if (result.source !== 'existing-config') {
    saveBrowserConfig(configPath, result.config);
  }

  return result;
}
