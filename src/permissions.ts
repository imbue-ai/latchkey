/**
 * Permission checking for outgoing HTTP requests based on the
 * Detent library.
 */

import { existsSync } from 'node:fs';
import { check, ConfigError, RequestSchemaError } from '@imbue-ai/detent';

export class PermissionCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionCheckError';
  }
}

/**
 * Check whether a request is allowed by permission rules.
 *
 * When no permissions config file is present at the given path, the check is
 * skipped (returns true). When a config exists, the request is validated
 * against its rules.
 *
 * @param request - The request to check.
 * @param configPath - Path to the permissions config file.
 * @param doNotUseBuiltinSchemas - When true, detent's built-in schemas are not used.
 * @returns true if the request is allowed (or no config exists), false if denied.
 * @throws PermissionCheckError if parsing or checking fails unexpectedly.
 */
export async function checkPermission(
  request: Request,
  configPath: string,
  doNotUseBuiltinSchemas = false
): Promise<boolean> {
  if (!existsSync(configPath)) {
    return true;
  }

  try {
    return await check(request, configPath, !doNotUseBuiltinSchemas);
  } catch (error) {
    if (error instanceof ConfigError || error instanceof RequestSchemaError) {
      throw new PermissionCheckError(`Permission check failed: ${error.message}`);
    }
    throw error;
  }
}
