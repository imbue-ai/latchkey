/**
 * Browser state management with encryption support.
 * Handles transparent encryption/decryption for Playwright storage state.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedStorage } from './encryptedStorage.js';

export class BrowserStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserStateError';
  }
}

/**
 * Manages browser state with encryption.
 * Provides a temporary decrypted file path for Playwright to use,
 * then encrypts the result back to the persistent storage.
 */
export class BrowserStateStore {
  private readonly persistentPath: string;
  private readonly encryptedStorage: EncryptedStorage;
  private tempDir: string | null = null;
  private tempFilePath: string | null = null;

  constructor(persistentPath: string, encryptedStorage: EncryptedStorage) {
    this.persistentPath = persistentPath;
    this.encryptedStorage = encryptedStorage;
  }

  /**
   * Prepare a temporary file path for Playwright to use.
   * If encrypted state exists, it will be decrypted to the temp file.
   * Returns the temp file path that Playwright should use.
   */
  prepare(): string {
    // Create a temporary directory for the decrypted state
    this.tempDir = mkdtempSync(join(tmpdir(), 'latchkey-browser-state-'));
    this.tempFilePath = join(this.tempDir, 'browser_state.json');

    // If state exists, decrypt it to the temp file
    try {
      const content = this.encryptedStorage.readFile(this.persistentPath);
      if (content !== null) {
        // Write decrypted content to temp file (unencrypted for Playwright)
        writeFileSync(this.tempFilePath, content, { encoding: 'utf-8', mode: 0o600 });
      }
    } catch (error) {
      throw new BrowserStateError(
        `Failed to prepare browser state: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return this.tempFilePath;
  }

  /**
   * Persist the browser state from the temporary file back to encrypted storage.
   * Should be called after Playwright has written the state.
   */
  persist(): void {
    if (this.tempFilePath === null) {
      throw new BrowserStateError('Browser state was not prepared. Call prepare() first.');
    }

    if (existsSync(this.tempFilePath)) {
      try {
        const content = readFileSync(this.tempFilePath, 'utf-8');
        this.encryptedStorage.writeFile(this.persistentPath, content);
      } catch (error) {
        throw new BrowserStateError(
          `Failed to persist browser state: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  /**
   * Clean up temporary files.
   * Should always be called when done, even if an error occurred.
   */
  cleanup(): void {
    if (this.tempFilePath !== null && existsSync(this.tempFilePath)) {
      try {
        unlinkSync(this.tempFilePath);
      } catch {
        // Ignore cleanup errors
      }
    }

    if (this.tempDir !== null && existsSync(this.tempDir)) {
      try {
        rmSync(this.tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }

    this.tempFilePath = null;
    this.tempDir = null;
  }

  /**
   * Get the temporary file path (must call prepare() first).
   */
  getTempPath(): string | null {
    return this.tempFilePath;
  }

  /**
   * Check if the persistent state exists.
   */
  hasState(): boolean {
    const actualPath = this.encryptedStorage.getActualPath(this.persistentPath);
    return existsSync(actualPath);
  }
}
