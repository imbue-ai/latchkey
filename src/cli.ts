#!/usr/bin/env node

/**
 * Command-line interface entry point for latchkey.
 */

import { program } from 'commander';
import { registerCommands, createDefaultDependencies } from './cliCommands.js';
import { InsecureFilePermissionsError } from './config.js';

const deps = createDefaultDependencies();

try {
  deps.config.checkSensitiveFilePermissions();
} catch (error) {
  if (error instanceof InsecureFilePermissionsError) {
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
  .version('0.1.0');

registerCommands(program, deps);

program.parse();
