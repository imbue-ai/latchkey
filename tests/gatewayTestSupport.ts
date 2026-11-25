/**
 * Starting a gateway for a test from the pieces the gateway's tests build: a
 * dependency object whose curl runner and permission check are stand-ins, a
 * store, and the options of the listener.
 */

import type { ApiCredentialStore } from '../src/apiCredentials/store.js';
import type { CliDependencies } from '../src/cliCommands.js';
import type { EncryptedStorage } from '../src/encryptedStorage.js';
import { loadExtensions } from '../src/gateway/extensions.js';
import { startGateway, type GatewayServer } from '../src/gateway/server.js';
import { assembleLatchkeyRuntime, type LatchkeyRuntime } from '../src/runtime.js';

export interface TestGatewayOptions {
  readonly port: number;
  readonly host: string;
  readonly maxBodySize: number;
  readonly password: string | null;
  readonly permissionsOverrideSigningKey: Buffer;
}

export function assembleTestRuntime(
  deps: CliDependencies,
  apiCredentialStore: ApiCredentialStore,
  encryptedStorage: EncryptedStorage,
  permissionsOverrideSigningKey: Buffer
): LatchkeyRuntime {
  return assembleLatchkeyRuntime({
    config: deps.config,
    encryptedStorage,
    apiCredentialStore,
    baseServices: deps.baseServices,
    apiCredentialsTypes: deps.apiCredentialsTypes,
    permissionsOverrideSigningKey,
    runCurlAsync: deps.runCurlAsync,
    checkPermission: deps.checkPermission,
    log: deps.log,
    errorLog: deps.errorLog,
    version: deps.version,
  });
}

/**
 * Start a gateway the way the `gateway` command does: over a runtime assembled
 * from the dependencies, with the extensions of the configuration's directory.
 */
export async function startTestGateway(
  deps: CliDependencies,
  apiCredentialStore: ApiCredentialStore,
  encryptedStorage: EncryptedStorage,
  options: TestGatewayOptions
): Promise<GatewayServer> {
  const runtime = assembleTestRuntime(
    deps,
    apiCredentialStore,
    encryptedStorage,
    options.permissionsOverrideSigningKey
  );
  return startGateway(runtime, {
    port: options.port,
    host: options.host,
    maxBodySize: options.maxBodySize,
    password: options.password,
    extensions: await loadExtensions(deps.config.extensionsDirectoryPath),
  });
}
