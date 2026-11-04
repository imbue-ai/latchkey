/**
 * Node starts its inspector (a local debug port with full read/write access to
 * the process's memory, including decrypted credentials) whenever the process
 * receives SIGUSR1, so any other process running as the same user could attach
 * to latchkey with a single `kill -USR1`. Installing a JavaScript listener for
 * the signal replaces Node's native handler, so the signal no longer activates
 * the inspector. Imported first in the CLI entry point to keep the window
 * before it takes effect as short as possible.
 */
process.on('SIGUSR1', () => {
  // Intentionally ignore the signal.
});
