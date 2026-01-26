#!/usr/bin/env node

/**
 * Command-line interface entry point for latchkey.
 */

import { program } from 'commander';
import { registerCommands, createDefaultDependencies } from './cliCommands.js';

program
  .name('latchkey')
  .description(
    'A command-line tool that injects API credentials to curl requests to known public APIs.'
  )
  .version('0.1.0');

const deps = await createDefaultDependencies();
registerCommands(program, deps);

program.parse();
