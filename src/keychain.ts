/**
 * System keychain integration for secure password storage.
 * Uses @napi-rs/keyring for cross-platform support (macOS Keychain, Windows Credential Manager,
 * Linux Secret Service via keyutils/kernel keyring).
 *
 * All operations have a timeout to prevent hanging when the keyring is locked.
 */

import { AsyncEntry } from '@napi-rs/keyring';
import { platform } from 'node:os';

const KEYRING_TIMEOUT_MILLISECONDS = 30_000;

export class KeychainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeychainError';
  }
}

export class KeychainNotAvailableError extends KeychainError {
  constructor(message: string) {
    super(message);
    this.name = 'KeychainNotAvailableError';
  }
}

export class KeychainTimeoutError extends KeychainError {
  constructor() {
    const linuxHint =
      platform() === 'linux'
        ? '\n\nOn Linux, you can try:\n' +
          '  - Unlocking your keyring: run a GUI app that accesses it, or use `gnome-keyring-daemon --unlock`\n' +
          '  - Bypassing the keyring entirely by setting LATCHKEY_ENCRYPTION_KEY:\n' +
          '      export LATCHKEY_ENCRYPTION_KEY="$(openssl rand -base64 32)"\n' +
          '    Add this to your shell profile to persist it across sessions.\n' +
          '    You may need to first delete any existing .enc files in your LATCHKEY_DIRECTORY\n' +
          '    (~/.latchkey by default) to reset any previously stored credentials.'
        : '';
    const timeoutSeconds = String(KEYRING_TIMEOUT_MILLISECONDS / 1000);
    super(
      `Could not access the system keyring within ${timeoutSeconds} seconds — it may be locked or unavailable.${linuxHint}`
    );
    this.name = 'KeychainTimeoutError';
  }
}

/**
 * Get an async keyring entry.
 */
function getEntry(serviceName: string, accountName: string): AsyncEntry {
  return new AsyncEntry(serviceName, accountName);
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/**
 * Store a password in the system keychain.
 * Throws KeychainTimeoutError if the keychain does not respond in time.
 * Throws KeychainNotAvailableError if the keychain is not accessible.
 */
export async function storeInKeychain(
  serviceName: string,
  accountName: string,
  password: string
): Promise<void> {
  try {
    const entry = getEntry(serviceName, accountName);
    await entry.setPassword(password, AbortSignal.timeout(KEYRING_TIMEOUT_MILLISECONDS));
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new KeychainTimeoutError();
    }
    throw new KeychainNotAvailableError(
      `Failed to store password in keychain: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Retrieve a password from the system keychain.
 * Returns null if the password is not found.
 * Throws KeychainTimeoutError if the keychain does not respond in time.
 * Throws KeychainNotAvailableError if the keychain is not accessible.
 */
export async function retrieveFromKeychain(
  serviceName: string,
  accountName: string
): Promise<string | null> {
  try {
    const entry = getEntry(serviceName, accountName);
    const password = await entry.getPassword(AbortSignal.timeout(KEYRING_TIMEOUT_MILLISECONDS));
    return password ?? null;
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new KeychainTimeoutError();
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Check if it's a "not found" error
    if (
      errorMessage.includes('not found') ||
      errorMessage.includes('No password') ||
      errorMessage.includes('ItemNotFound')
    ) {
      return null;
    }
    throw new KeychainNotAvailableError(
      `Failed to retrieve password from keychain: ${errorMessage}`
    );
  }
}

/**
 * Delete a password from the system keychain.
 * Returns true if deleted, false if not found.
 * Throws KeychainTimeoutError if the keychain does not respond in time.
 * Throws KeychainNotAvailableError if the keychain is not accessible.
 */
export async function deleteFromKeychain(
  serviceName: string,
  accountName: string
): Promise<boolean> {
  try {
    const entry = getEntry(serviceName, accountName);
    await entry.deletePassword(AbortSignal.timeout(KEYRING_TIMEOUT_MILLISECONDS));
    return true;
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new KeychainTimeoutError();
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (
      errorMessage.includes('not found') ||
      errorMessage.includes('No password') ||
      errorMessage.includes('ItemNotFound')
    ) {
      return false;
    }
    throw new KeychainNotAvailableError(`Failed to delete password from keychain: ${errorMessage}`);
  }
}
