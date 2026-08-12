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
 * Latchkey-supplied context for a permission check, exposed to detent schemas
 * and hooks as the `customMetadata` property of the decomposed request.
 */
export interface PermissionCheckMetadata {
  /**
   * Account whose credentials are injected into the request (the empty string
   * denotes the default account). Omitted when no credentials are injected,
   * i.e. when the request is passed through or handled by an extension.
   */
  readonly account?: string;
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
 * @param metadata - Latchkey context exposed to schemas as `customMetadata`.
 *   When omitted, detent falls back to the DETENT_CUSTOM_METADATA environment
 *   variable.
 * @returns true if the request is allowed (or no config exists), false if denied.
 * @throws PermissionCheckError if parsing or checking fails unexpectedly.
 */
export async function checkPermission(
  request: Request,
  configPath: string,
  doNotUseBuiltinSchemas = false,
  metadata?: PermissionCheckMetadata
): Promise<boolean> {
  if (!existsSync(configPath)) {
    return true;
  }

  try {
    // Spread into a plain object so the metadata satisfies detent's open-ended
    // `CustomMetadata` record type.
    const customMetadata = metadata === undefined ? undefined : { ...metadata };
    return await check(request, configPath, !doNotUseBuiltinSchemas, customMetadata);
  } catch (error) {
    if (error instanceof ConfigError || error instanceof RequestSchemaError) {
      throw new PermissionCheckError(`Permission check failed: ${error.message}`);
    }
    throw error;
  }
}
