/**
 * System keychain integration for secure password storage.
 * Uses @napi-rs/keyring for cross-platform support (macOS Keychain, Windows Credential Manager,
 * Linux Secret Service via keyutils/kernel keyring).
 */

import { Entry } from '@napi-rs/keyring';

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

/**
 * Get a keyring entry.
 */
function getEntry(serviceName: string, accountName: string): Entry {
  return new Entry(serviceName, accountName);
}

/**
 * Store a password in the system keychain.
 * Throws KeychainNotAvailableError if the keychain is not accessible.
 */
export function storeInKeychain(serviceName: string, accountName: string, password: string): void {
  try {
    const entry = getEntry(serviceName, accountName);
    entry.setPassword(password);
  } catch (error) {
    throw new KeychainNotAvailableError(
      `Failed to store password in keychain: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Retrieve a password from the system keychain.
 * Returns null if the password is not found.
 * Throws KeychainNotAvailableError if the keychain is not accessible.
 */
export function retrieveFromKeychain(serviceName: string, accountName: string): string | null {
  try {
    const entry = getEntry(serviceName, accountName);
    const password = entry.getPassword();
    return password ?? null;
  } catch (error) {
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
 * Throws KeychainNotAvailableError if the keychain is not accessible.
 */
export function deleteFromKeychain(serviceName: string, accountName: string): boolean {
  try {
    const entry = getEntry(serviceName, accountName);
    entry.deletePassword();
    return true;
  } catch (error) {
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

/**
 * Check if the system keychain is available.
 */
export function isKeychainAvailable(serviceName: string, accountName: string): boolean {
  try {
    // Try to create an entry - this should work on all supported platforms
    getEntry(serviceName, accountName);
    return true;
  } catch {
    return false;
  }
}
