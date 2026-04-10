/**
 * Permission checking for outgoing HTTP requests based on the
 * Detent library.
 *
 * When a permissions config file exists, outgoing curl requests are checked
 * against the user's permission rules before being sent.
 */

import { existsSync } from 'node:fs';
import { check, parseCurlArgs, CurlParseError, ConfigError } from '@imbue-ai/detent';

export class PermissionCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionCheckError';
  }
}

/**
 * Check whether a curl request is allowed by permission rules.
 *
 * When no permissions config file is present at the given path, the check is
 * skipped (returns true). When a config exists, the request is validated
 * against its rules.
 *
 * @param curlArguments - The raw curl arguments (before credential injection).
 * @param configPath - Path to the permissions config file.
 * @returns true if the request is allowed (or no config exists), false if denied.
 * @throws PermissionCheckError if parsing or checking fails unexpectedly.
 */
export async function checkPermission(
  curlArguments: readonly string[],
  configPath: string
): Promise<boolean> {
  if (!existsSync(configPath)) {
    return true;
  }

  try {
    const request = parseCurlArgs(curlArguments);
    return await check(request, configPath);
  } catch (error) {
    if (error instanceof CurlParseError || error instanceof ConfigError) {
      throw new PermissionCheckError(`Permission check failed: ${error.message}`);
    }
    throw error;
  }
}
