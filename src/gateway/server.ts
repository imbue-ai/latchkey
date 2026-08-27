/**
 * Local HTTP gateway server.
 *
 * Routes incoming requests to either the `/gateway/<target-url>` proxy handler
 * or the `/latchkey/` RPC endpoint.
 */

import * as http from 'node:http';
import type { ApiCredentialStore } from '../apiCredentials/store.js';
import type { CliDependencies } from '../cliCommands.js';
import type { Config } from '../config.js';
import type { EncryptedStorage } from '../encryptedStorage.js';
import { ErrorMessages } from '../errorMessages.js';
import { setCurlCommand } from '../curl.js';
import {
  extractTargetUrl,
  GATEWAY_PATH_PREFIX,
  handleGatewayRequest,
  type GatewayOptions,
} from './gatewayEndpoint.js';
import { handleLatchkeyRequest } from './latchkeyEndpoint.js';
import { GATEWAY_PASSWORD_HEADER, passwordsMatch } from './password.js';
import { createServiceRegistry } from '../serviceRegistry.js';
import {
  dispatchExtensionRequest,
  loadExtensions,
  startExtensions,
  stopExtensions,
  type LoadedExtension,
} from './extensions.js';
import {
  InvalidPermissionsOverrideError,
  PermissionsOverrideFileMissingError,
  resolveRequestPermissionsConfig,
} from './permissionsOverride.js';

function sendErrorResponse(
  response: http.ServerResponse,
  statusCode: number,
  message: string
): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: message }));
}

/**
 * Read a single header value, treating arrays (which Node returns for some
 * headers) as missing because the password header is not allowed to repeat.
 */
function readSingleHeader(request: http.IncomingMessage, headerName: string): string | undefined {
  const value = request.headers[headerName];
  if (typeof value === 'string') return value;
  return undefined;
}

/**
 * If a password is configured, verify that the request presents it in the
 * expected header. Returns true when the request should be allowed to
 * proceed, and writes a 401 response and returns false otherwise.
 */
function enforcePassword(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  expectedPassword: string | null,
  deps: CliDependencies
): boolean {
  if (expectedPassword === null) return true;
  const provided = readSingleHeader(request, GATEWAY_PASSWORD_HEADER);
  if (provided !== undefined && passwordsMatch(expectedPassword, provided)) {
    return true;
  }
  const method = request.method ?? 'UNKNOWN';
  const path = request.url ?? '';
  deps.log(`${method} ${path} -> 401 (password)`);
  sendErrorResponse(response, 401, 'Unauthorized: invalid or missing Latchkey gateway password.');
  return false;
}

export interface GatewayServer {
  readonly server: http.Server;
  readonly close: () => Promise<void>;
}

/**
 * Run an inbound request through the loaded extensions. Resolves to true when
 * the request has been handled in some way and false if not.
 */
function runExtensions(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  extensions: readonly LoadedExtension[],
  deps: CliDependencies,
  options: GatewayOptions
): Promise<boolean> {
  if (extensions.length === 0) return Promise.resolve(false);

  const rawUrl = request.url ?? '';
  const method = (request.method ?? 'GET').toUpperCase();

  let permissionsConfigPath: string;
  try {
    permissionsConfigPath = resolveRequestPermissionsConfig(
      request.headers,
      deps.config.permissionsConfigPath,
      options.permissionsOverrideSigningKey
    );
  } catch (error) {
    if (error instanceof InvalidPermissionsOverrideError) {
      deps.log(`${method} ${rawUrl} -> 401 (extension)`);
      sendErrorResponse(response, 401, error.message);
      return Promise.resolve(true);
    }
    if (error instanceof PermissionsOverrideFileMissingError) {
      deps.log(`${method} ${rawUrl} -> 400 (extension)`);
      sendErrorResponse(response, 400, error.message);
      return Promise.resolve(true);
    }
    // resolveRequestPermissionsConfig only throws the two known error
    // types, so this branch is just defensive: an http.Server request
    // listener is sync, and rethrowing here would crash the process.
    deps.errorLog(
      `Unexpected error resolving permissions override for ${method} ${rawUrl}: ` +
        (error instanceof Error ? error.message : String(error))
    );
    sendErrorResponse(response, 500, 'Internal error');
    return Promise.resolve(true);
  }

  return dispatchExtensionRequest(request, response, extensions, deps, permissionsConfigPath);
}

/**
 * Settings a running gateway reads again but cannot act on, with the reason it
 * cannot. Everything else in the config takes effect on the next request, so
 * these are the ones worth telling the user about rather than leaving to be
 * discovered.
 */
interface StartupOnlySetting {
  readonly name: string;
  readonly reason: string;
  readonly read: (config: Config) => string | number | boolean;
}

const STARTUP_ONLY_SETTINGS: readonly StartupOnlySetting[] = [
  {
    name: 'keyringServiceName',
    reason: 'the encryption key was resolved before the server started',
    read: (config) => config.serviceName,
  },
  {
    name: 'keyringAccountName',
    reason: 'the encryption key was resolved before the server started',
    read: (config) => config.accountName,
  },
  {
    name: 'gatewayListenHost',
    reason: 'the listening socket is already bound',
    read: (config) => config.gatewayListenHost,
  },
  {
    name: 'gatewayListenPort',
    reason: 'the listening socket is already bound',
    read: (config) => config.gatewayListenPort,
  },
  {
    name: 'countingDisabled',
    reason: 'daily counting runs once, at startup',
    read: (config) => config.countingDisabled,
  },
];

/**
 * Report settings that changed since startup but cannot take effect until the
 * gateway is restarted. Each is reported once, so that a config left in place
 * does not repeat itself on every request.
 */
function reportSettingChangesNeedingRestart(
  startupConfig: Config,
  requestConfig: Config,
  alreadyReported: Set<string>,
  deps: CliDependencies
): void {
  for (const setting of STARTUP_ONLY_SETTINGS) {
    if (alreadyReported.has(setting.name)) {
      continue;
    }
    if (setting.read(startupConfig) === setting.read(requestConfig)) {
      continue;
    }
    alreadyReported.add(setting.name);
    deps.errorLog(
      `Warning: '${setting.name}' has changed, but this gateway cannot apply it ` +
        `because ${setting.reason}. Restart the gateway for it to take effect.`
    );
  }
}

/**
 * Start the gateway HTTP server.
 */
export async function startGateway(
  deps: CliDependencies,
  apiCredentialStore: ApiCredentialStore,
  encryptedStorage: EncryptedStorage,
  options: GatewayOptions
): Promise<GatewayServer> {
  const inFlightRequests = new Set<Promise<void>>();

  const extensions = await loadExtensions(deps.config.extensionsDirectoryPath);
  await startExtensions(extensions);

  const settingChangesReported = new Set<string>();

  const server = http.createServer((request, response) => {
    const rawUrl = request.url ?? '';
    const method = request.method ?? 'UNKNOWN';

    if (!enforcePassword(request, response, options.password, deps)) {
      return;
    }

    // Health endpoint
    if (rawUrl === '/' && method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', version: deps.version }));
      return;
    }

    // Read the environment and config.json again, so that everything the
    // request path consults reflects what they say now rather than what they
    // said at startup. Each request gets its own config and registry: shared
    // ones would change underneath requests already in flight.
    //
    // Hiding is re-applied here from the config as it reads now, which works
    // because the registry is rebuilt from the full set of built-in services: a
    // name dropped from hideBuiltinServices brings its service back.
    const requestConfig = deps.config.reload();
    reportSettingChangesNeedingRestart(deps.config, requestConfig, settingChangesReported, deps);
    const requestDeps: CliDependencies = {
      ...deps,
      config: requestConfig,
      registry: createServiceRegistry(
        deps.builtinServices,
        requestConfig.configPath,
        requestConfig.hideBuiltinServices
      ),
    };

    // curl is spawned from call sites deep inside the services, which reach the
    // runner directly rather than through these dependencies, so the command to
    // spawn is handed to that module instead of threaded down to them. Every
    // request computes it from the same file, so concurrent requests write the
    // same value except in the moment the file itself changes.
    setCurlCommand(requestConfig.curlCommand);

    // Latchkey RPC endpoint
    if (rawUrl === '/latchkey/' || rawUrl === '/latchkey') {
      const requestPromise = handleLatchkeyRequest(
        request,
        response,
        requestDeps,
        apiCredentialStore,
        encryptedStorage
      ).catch((error: unknown) => {
        deps.errorLog(
          `Unexpected error handling /latchkey/: ${error instanceof Error ? error.message : String(error)}`
        );
        if (!response.headersSent) {
          sendErrorResponse(response, 500, 'Internal error');
        }
      });

      inFlightRequests.add(requestPromise);
      void requestPromise.finally(() => {
        inFlightRequests.delete(requestPromise);
      });
      return;
    }

    // Gateway proxy endpoint
    if (rawUrl.startsWith(GATEWAY_PATH_PREFIX)) {
      const targetUrl = extractTargetUrl(rawUrl);
      if (targetUrl === null) {
        deps.log(`${method} ${rawUrl.slice(GATEWAY_PATH_PREFIX.length)} -> 400`);
        sendErrorResponse(response, 400, ErrorMessages.couldNotExtractUrl);
        return;
      }

      const requestPromise = handleGatewayRequest(
        request,
        response,
        targetUrl,
        requestDeps,
        apiCredentialStore,
        options
      ).catch((error: unknown) => {
        deps.errorLog(
          `Unexpected error handling ${method} ${targetUrl}: ${error instanceof Error ? error.message : String(error)}`
        );
        if (!response.headersSent) {
          sendErrorResponse(response, 502, ErrorMessages.upstreamRequestFailed);
        }
      });

      inFlightRequests.add(requestPromise);
      void requestPromise.finally(() => {
        inFlightRequests.delete(requestPromise);
      });
      return;
    }

    // Finally, try extensions (if any).
    const requestPromise = runExtensions(request, response, extensions, requestDeps, options)
      .then((handled) => {
        if (!handled && !response.headersSent) {
          response.writeHead(404);
          response.end();
        }
      })
      .catch((error: unknown) => {
        deps.errorLog(
          `Unexpected error handling extension request ${method} ${rawUrl}: ` +
            (error instanceof Error ? error.message : String(error))
        );
        if (!response.headersSent) {
          sendErrorResponse(response, 500, 'Internal error');
        }
      });
    inFlightRequests.add(requestPromise);
    void requestPromise.finally(() => {
      inFlightRequests.delete(requestPromise);
    });
  });

  const SHUTDOWN_TIMEOUT_MS = 10_000;

  const close = (): Promise<void> => {
    return new Promise((resolve) => {
      deps.log('Shutting down...');

      // Give extensions a chance to release long-lived connections. A
      // well-behaved stop() hook ends every response the extension is
      // holding open, which lets server.close() complete naturally well
      // before the force-close timeout fires. We don't await this here:
      // server.close() will only signal completion once the response
      // count actually drops to zero, so the two run concurrently and
      // the result is the same either way.
      void stopExtensions(extensions, deps);

      server.close(() => {
        resolve();
      });

      // Force-close after timeout
      setTimeout(() => {
        server.closeAllConnections();
        resolve();
      }, SHUTDOWN_TIMEOUT_MS);
    });
  };

  return new Promise((resolve, reject) => {
    server.on('error', reject);

    server.listen(options.port, options.host, () => {
      const passwordNote = options.password === null ? '' : ' (password authentication enabled)';
      deps.log(
        `Latchkey gateway listening on ${options.host}:${String(options.port)}${passwordNote}`
      );
      resolve({ server, close });
    });
  });
}
