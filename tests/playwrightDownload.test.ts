import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import {
  getChromiumExecutable,
  downloadFile,
  setExecutablePermissions,
  BrowserDownloadError,
} from '../src/playwrightDownload.js';

describe('playwrightDownload', () => {
  describe('getChromiumExecutable', () => {
    it('should return Chromium executable info with download URLs', () => {
      const executable = getChromiumExecutable();

      expect(executable.name).toBe('chromium');
      expect(executable.directory).toBeDefined();
      expect(executable.downloadURLs!.length).toBeGreaterThan(0);

      for (const url of executable.downloadURLs!) {
        expect(url).toMatch(/^https:\/\//);
      }
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
});
