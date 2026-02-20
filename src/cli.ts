#!/usr/bin/env node

/**
 * Command-line interface entry point for latchkey.
 */

import { program } from 'commander';
import { registerCommands, createDefaultDependencies } from './cliCommands.js';
import { CurlNotFoundError, InsecureFilePermissionsError } from './config.js';
import { EncryptedStorage } from './encryptedStorage.js';
import { MigrationError, runMigrations } from './migrations.js';
import packageJson from '../package.json' with { type: 'json' };

const deps = createDefaultDependencies();

try {
  deps.config.checkSensitiveFilePermissions();
  deps.config.checkSystemPrerequisites();
} catch (error) {
  if (error instanceof InsecureFilePermissionsError || error instanceof CurlNotFoundError) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
  throw error;
}

try {
  const encryptedStorage = new EncryptedStorage({
    encryptionKeyOverride: deps.config.encryptionKeyOverride,
    serviceName: deps.config.serviceName,
    accountName: deps.config.accountName,
  });
  runMigrations(deps.config, encryptedStorage);
} catch (error) {
  if (error instanceof MigrationError) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
  throw error;
}

program
  .name('latchkey')
  .description(
    'A command-line tool that injects API credentials to curl requests to known public APIs.'
  )
  .version(packageJson.version);

registerCommands(program, deps);

program.parse();
