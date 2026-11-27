/**
 * What has to happen before any command runs, shared by the `latchkey`
 * executable and the entry points for embedding Latchkey in another program.
 */

import { resolveEncryptionKeyFromConfig } from './cliCommands.js';
import { CurlNotFoundError, InsecureFilePermissionsError, type Config } from './config.js';
import { countDailyIfNeeded } from './dailyCounting.js';
import { EncryptedStorage } from './encryptedStorage.js';
import { EncryptionKeyLostError, EncryptionKeyUnavailableError } from './encryption.js';
import { KeychainTimeoutError } from './keychain.js';
import { MigrationError, runMigrations } from './migrations.js';
import { PluginLoadError } from './plugins.js';

/**
 * Check the prerequisites and, unless commands are delegated to a remote
 * gateway, the file permissions, and migrate the data directory.
 */
export async function runStartupTasks(config: Config): Promise<void> {
  config.checkSystemPrerequisites();
  if (config.gatewayUrl !== null) {
    return;
  }
  config.checkSensitiveFilePermissions();
  try {
    countDailyIfNeeded(config);
  } catch {
    // Non-essential daily usage counting — never prevent the main application from running.
  }
  const encryptionKey = await resolveEncryptionKeyFromConfig(config);
  await runMigrations(config, new EncryptedStorage(encryptionKey));
}

/**
 * The message to show for an error that is an expected way for startup to
 * fail, or null for any other error.
 */
export function describeStartupError(error: unknown): string | null {
  if (error instanceof EncryptionKeyUnavailableError) {
    return (
      'No encryption key available.\n\n' +
      'Latchkey needs an encryption key to store credentials securely.\n' +
      'Either ensure your system keychain is accessible, or set the\n' +
      'LATCHKEY_ENCRYPTION_KEY environment variable. For example:\n\n' +
      '  export LATCHKEY_ENCRYPTION_KEY="$(openssl rand -base64 32)"\n\n' +
      'Add this to your shell profile to persist it across sessions.'
    );
  }
  if (
    error instanceof PluginLoadError ||
    error instanceof InsecureFilePermissionsError ||
    error instanceof CurlNotFoundError ||
    error instanceof KeychainTimeoutError ||
    error instanceof EncryptionKeyLostError ||
    error instanceof MigrationError
  ) {
    return `Error: ${error.message}`;
  }
  return null;
}
