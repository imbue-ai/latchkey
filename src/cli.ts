#!/usr/bin/env node

/**
 * Command-line interface entry point for latchkey.
 */

import { createDefaultDependencies, createProgram } from './cliCommands.js';
import { describeStartupError, runStartupTasks } from './startup.js';

// Node starts its inspector (a local debug port with full access to the
// process's memory, including decrypted credentials) whenever it receives
// SIGUSR1, so any process running as the same user could attach with a single
// `kill -USR1`. A JavaScript listener replaces Node's native handler, so the
// signal no longer activates the inspector.
process.on('SIGUSR1', () => {
  // Intentionally ignore the signal.
});

try {
  const deps = await createDefaultDependencies();
  await runStartupTasks(deps.config);
  createProgram(deps).parse();
} catch (error) {
  const message = describeStartupError(error);
  if (message === null) {
    throw error;
  }
  console.error(message);
  process.exit(1);
}
