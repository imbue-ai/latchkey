import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import {
  getChromiumExecutable,
  downloadFile,
  extractZip,
  setExecutablePermissions,
  BrowserDownloadError,
  BrowserExtractionError,
} from '../src/playwrightDownload.js';

describe('playwrightDownload', () => {
  describe('getChromiumExecutable', () => {
    it('should return Chromium executable info from Playwright registry', () => {
      const executable = getChromiumExecutable();

      expect(executable).toBeDefined();
      expect(executable.name).toBe('chromium');
      expect(executable.directory).toBeDefined();
      expect(typeof executable.directory).toBe('string');
      expect(executable.executablePath.bind(executable)).toBeDefined();
      expect(typeof executable.executablePath).toBe('function');
    });

    it('should return download URLs for Chromium', () => {
      const executable = getChromiumExecutable();

      expect(executable.downloadURLs).toBeDefined();
      expect(Array.isArray(executable.downloadURLs)).toBe(true);
      expect(executable.downloadURLs!.length).toBeGreaterThan(0);

      // Each URL should be a valid HTTPS URL
      for (const url of executable.downloadURLs!) {
        expect(url).toMatch(/^https:\/\//);
        expect(url).toContain('chromium');
      }
    });

    it('should return an executable path function', () => {
      const executable = getChromiumExecutable();

      const path = executable.executablePath('javascript');
      expect(path).toBeDefined();
      expect(typeof path).toBe('string');
      expect(path!.length).toBeGreaterThan(0);
    });
  });

  describe('downloadFile', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'latchkey-download-test-'));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('should download a file from HTTPS URL', async () => {
      const destinationPath = join(tempDir, 'test-file.txt');

      // Use a small, reliable test URL
      await downloadFile('https://httpbin.org/robots.txt', destinationPath);

      expect(existsSync(destinationPath)).toBe(true);
      const stats = statSync(destinationPath);
      expect(stats.size).toBeGreaterThan(0);
    }, 30000);

    it('should throw BrowserDownloadError for non-existent URL', async () => {
      const destinationPath = join(tempDir, 'test-file.txt');

      await expect(downloadFile('https://httpbin.org/status/404', destinationPath)).rejects.toThrow(
        BrowserDownloadError
      );
    }, 30000);

    it('should create parent directories if they do not exist', async () => {
      const nestedPath = join(tempDir, 'nested', 'directory', 'test-file.txt');

      await downloadFile('https://httpbin.org/robots.txt', nestedPath);

      expect(existsSync(nestedPath)).toBe(true);
    }, 30000);

    it('should handle redirects', async () => {
      const destinationPath = join(tempDir, 'redirected-file.txt');

      // httpbin.org/redirect-to redirects to the specified URL
      await downloadFile(
        'https://httpbin.org/redirect-to?url=https%3A%2F%2Fhttpbin.org%2Frobots.txt',
        destinationPath
      );

      expect(existsSync(destinationPath)).toBe(true);
    }, 30000);
  });

  describe('extractZip', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'latchkey-extract-test-'));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('should create destination directory if it does not exist', async () => {
      const destinationDir = join(tempDir, 'non-existent-dir');

      // This will fail because there's no valid zip, but the directory should be created
      try {
        await extractZip(join(tempDir, 'fake.zip'), destinationDir);
      } catch {
        // Expected to fail, but directory should exist
      }

      expect(existsSync(destinationDir)).toBe(true);
    });
  });

  describe('setExecutablePermissions', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'latchkey-permissions-test-'));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('should set executable permissions on a file (non-Windows)', () => {
      if (platform() === 'win32') {
        // Skip on Windows as file permissions work differently
        return;
      }

      const filePath = join(tempDir, 'test-executable');
      writeFileSync(filePath, '#!/bin/sh\necho "test"', { mode: 0o644 });

      setExecutablePermissions(filePath);

      const stats = statSync(filePath);
      // Check that the file is executable (at least owner execute bit)
      expect(stats.mode & 0o100).toBe(0o100);
    });

    it('should not throw if file does not exist', () => {
      const nonExistentPath = join(tempDir, 'non-existent-file');

      // Should not throw
      expect(() => {
        setExecutablePermissions(nonExistentPath);
      }).not.toThrow();
    });
  });

  describe('error classes', () => {
    it('BrowserDownloadError should have correct name', () => {
      const error = new BrowserDownloadError('test message');

      expect(error.name).toBe('BrowserDownloadError');
      expect(error.message).toBe('test message');
      expect(error instanceof Error).toBe(true);
    });

    it('BrowserExtractionError should have correct name', () => {
      const error = new BrowserExtractionError('test message');

      expect(error.name).toBe('BrowserExtractionError');
      expect(error.message).toBe('test message');
      expect(error instanceof Error).toBe(true);
    });
  });
});
