import { describe, it, expect } from 'vitest';
import { macOSAppBundlePath } from '../src/playwrightMacLaunch.js';

describe('macOSAppBundlePath', () => {
  it('derives the .app bundle from a Chrome executable path', () => {
    expect(
      macOSAppBundlePath('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ).toBe('/Applications/Google Chrome.app');
  });

  it('derives the bundle for Chromium', () => {
    expect(macOSAppBundlePath('/Applications/Chromium.app/Contents/MacOS/Chromium')).toBe(
      '/Applications/Chromium.app'
    );
  });

  it('derives the bundle for Edge', () => {
    expect(
      macOSAppBundlePath('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
    ).toBe('/Applications/Microsoft Edge.app');
  });

  it('derives the bundle for Chrome Canary', () => {
    expect(
      macOSAppBundlePath(
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'
      )
    ).toBe('/Applications/Google Chrome Canary.app');
  });

  it('derives the bundle for Playwright bundled Chrome for Testing at a nested path', () => {
    expect(
      macOSAppBundlePath(
        '/Users/me/Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
      )
    ).toBe(
      '/Users/me/Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app'
    );
  });

  it('falls back to the Google Chrome app name when no bundle can be inferred', () => {
    expect(macOSAppBundlePath(undefined)).toBe('Google Chrome');
    // A bare binary path (no .app) resolves to the LaunchServices app-name fallback.
    expect(macOSAppBundlePath('/opt/homebrew/bin/chromium')).toBe('Google Chrome');
  });
});
