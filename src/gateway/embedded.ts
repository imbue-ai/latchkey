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
import { runWithConfig, configFromEnvironment, type LatchkeyEnvironment } from '../config.js';
import { EncryptedStorage } from '../encryptedStorage.js';
import { runStartupTasks } from '../startup.js';
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
   * Extensions to serve instead of the ones in the extensions directory,
   * which is then not read at all; an empty list means no extensions. They
   * go through the same permission check. To serve both, add the result of
   * `loadExtensions` on that directory to the list.
   */
  readonly extensions?: readonly Extension[];
  /**
   * Where the `LATCHKEY_*` variables are taken from, instead of `process.env`
   * (and `LATCHKEY_ENV_OVERRIDES_FD`): one that is set there but not here
   * counts as unset. Everything else, such as `PATH` and the environment curl
   * is spawned with, stays that of the process. Read once, when the gateway
   * is created.
   */
  readonly env?: LatchkeyEnvironment;
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
  const config = configFromEnvironment(options.env);
  const gateway = await runWithConfig(config, () =>
    createEmbeddedGatewayWithCurrentConfig(options)
  );
  // Requests come in outside of this call, so each has to be given the
  // configuration again.
  return {
    handleRequest: (request, response) => {
      runWithConfig(config, () => {
        gateway.handleRequest(request, response);
      });
    },
    close: () => runWithConfig(config, () => gateway.close()),
  };
}

async function createEmbeddedGatewayWithCurrentConfig(
  options: EmbeddedGatewayOptions
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
  await runStartupTasks(deps.config);

  const encryptionKey = await resolveEncryptionKeyFromConfig(deps.config);
  const encryptedStorage = new EncryptedStorage(encryptionKey);

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
