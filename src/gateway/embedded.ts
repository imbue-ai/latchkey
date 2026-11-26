/**
 * The gateway as a request handler for an HTTP server owned by another
 * program, configured the way `latchkey gateway` is: by the `LATCHKEY_*`
 * environment variables and the Latchkey directory.
 */

import {
  createApiCredentialStore,
  createDefaultDependencies,
  resolveEncryptionKeyFromConfig,
} from '../cliCommands.js';
import { countDailyIfNeeded } from '../dailyCounting.js';
import { EncryptedStorage } from '../encryptedStorage.js';
import { runMigrations } from '../migrations.js';
import type { Extension } from './extensions.js';
import { DEFAULT_GATEWAY_MAX_BODY_SIZE } from './gatewayEndpoint.js';
import { derivePermissionsOverrideSigningKey } from './permissionsOverride.js';
import { createGatewayRequestHandler, type GatewayRequestHandler } from './server.js';

export class EmbeddedGatewayInGatewayModeError extends Error {
  constructor() {
    super(
      'Cannot serve a Latchkey gateway while LATCHKEY_GATEWAY points this process at a remote one.'
    );
    this.name = 'EmbeddedGatewayInGatewayModeError';
  }
}

export interface EmbeddedGatewayOptions {
  /** Maximum request body size in bytes. */
  readonly maxBodySize?: number;
  /** Where the per-request log lines go. Defaults to `console.log`. */
  readonly log?: (message: string) => void;
  /** Defaults to `console.error`. */
  readonly errorLog?: (message: string) => void;
  /**
   * Extensions to serve in addition to the ones in the extensions directory,
   * and tried before them. They go through the same permission check.
   */
  readonly extensions?: readonly Extension[];
}

/**
 * Build the gateway's request handler, doing what the `latchkey` executable
 * does on startup first: checking prerequisites and file permissions,
 * resolving the encryption key and migrating the data directory. Rejects
 * with the same errors that make the executable exit.
 */
export async function createEmbeddedGateway(
  options: EmbeddedGatewayOptions = {}
): Promise<GatewayRequestHandler> {
  const defaultDependencies = await createDefaultDependencies();
  const deps = {
    ...defaultDependencies,
    log: options.log ?? defaultDependencies.log,
    errorLog: options.errorLog ?? defaultDependencies.errorLog,
  };
  if (deps.config.gatewayUrl !== null) {
    throw new EmbeddedGatewayInGatewayModeError();
  }
  deps.config.checkSystemPrerequisites();
  deps.config.checkSensitiveFilePermissions();
  try {
    countDailyIfNeeded(deps.config);
  } catch {
    // Non-essential daily usage counting — never prevent the gateway from being served.
  }

  const encryptionKey = await resolveEncryptionKeyFromConfig(deps.config);
  const encryptedStorage = new EncryptedStorage(encryptionKey);
  await runMigrations(deps.config, encryptedStorage);

  return createGatewayRequestHandler(
    deps,
    createApiCredentialStore(deps, encryptedStorage),
    encryptedStorage,
    {
      maxBodySize: options.maxBodySize ?? DEFAULT_GATEWAY_MAX_BODY_SIZE,
      password: deps.config.gatewayListenPassword,
      permissionsOverrideSigningKey: derivePermissionsOverrideSigningKey(encryptionKey),
    },
    options.extensions
  );
}
