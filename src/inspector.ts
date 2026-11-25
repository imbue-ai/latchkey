/**
 * Keeping the Node.js inspector closed.
 */

/**
 * Keep Node.js from opening its inspector when the process receives SIGUSR1.
 *
 * Node starts its inspector (a local debug port with full access to the
 * process's memory, including decrypted credentials) whenever it receives
 * SIGUSR1, so any process running as the same user could attach with a single
 * `kill -USR1`. A JavaScript listener replaces Node's native handler, so the
 * signal no longer activates the inspector.
 *
 * A process that holds decrypted credentials should call this before anything
 * else. The command line does; a program that embeds Latchkey has to do it for
 * itself, because a library does not install signal handlers on its own.
 */
export function ignoreInspectorSignal(): void {
  process.on('SIGUSR1', () => {
    // Intentionally ignore the signal.
  });
}
