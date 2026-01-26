/**
 * Browser state management utilities.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";

const LATCHKEY_BROWSER_STATE_ENV_VAR = "LATCHKEY_BROWSER_STATE";

/**
 * Get the browser state path from the LATCHKEY_BROWSER_STATE environment variable.
 */
export function getBrowserStatePath(): string | null {
  const envValue = process.env[LATCHKEY_BROWSER_STATE_ENV_VAR];
  if (envValue) {
    // Expand ~ to home directory
    if (envValue.startsWith("~")) {
      return resolve(homedir(), envValue.slice(2));
    }
    return resolve(envValue);
  }
  return null;
}
