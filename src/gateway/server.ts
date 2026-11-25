/**
 * The gateway: a request handler over a runtime, and the HTTP server the
 * command line puts in front of it.
 *
 * `createGatewayRequestHandler` routes a request to the `/gateway/<target-url>`
 * proxy, to the `/latchkey/` RPC endpoint, or to the gateway's extensions. It
 * owns no socket: the caller attaches it to a server of its own. `startGateway`
 * is that server for a caller that wants one listener and nothing more.
 */

import * as http from 'node:http';
import { ErrorMessages } from '../errorMessages.js';
import {
  extractTargetUrl,
  GATEWAY_PATH_PREFIX,
  handleGatewayRequest,
  type GatewayDependencies,
  type GatewayRequestSettings,
} from './gatewayEndpoint.js';
import { handleLatchkeyRequest } from './latchkeyEndpoint.js';
import { decodeHeaderValue } from './headerEncoding.js';
import { GATEWAY_PASSWORD_HEADER, passwordsMatch } from './password.js';
import {
  dispatchExtensionRequest,
  startExtensions,
  stopExtensions,
  type GatewayExtension,
} from './extensions.js';
import {
  InvalidPermissionsOverrideError,
  PermissionsOverrideFileMissingError,
  resolveRequestPermissionsConfig,
} from './permissionsOverride.js';
import { getLatchkeyRuntimeInternals, type LatchkeyRuntime } from '../runtime.js';

/**
 * How long `startGateway`'s `close` waits for the requests in flight before it
 * ends them.
 */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * How long a `stop` that had to end requests waits for their handlers to
 * return before it gives up on them. A killed curl and a destroyed response
 * make a handler return at once; this only bounds the wait for one that does
 * not.
 */
const FORCED_END_GRACE_MS = 5_000;

function sendErrorResponse(
  response: http.ServerResponse,
  statusCode: number,
  message: string,
  extraHeaders: http.OutgoingHttpHeaders = {}
): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json', ...extraHeaders });
  response.end(JSON.stringify({ error: message, latchkeyError: true }));
}

/**
 * Read a single header value, treating arrays (which Node returns for some
 * headers) as missing because the password header is not allowed to repeat.
 * The value is decoded out of Node's latin-1 rendering so that a password
 * containing non-ASCII characters compares equal to the configured one.
 */
function readSingleHeader(request: http.IncomingMessage, headerName: string): string | undefined {
  const value = request.headers[headerName];
  if (typeof value === 'string') return decodeHeaderValue(value);
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
  log: (message: string) => void
): boolean {
  if (expectedPassword === null) return true;
  const provided = readSingleHeader(request, GATEWAY_PASSWORD_HEADER);
  if (provided !== undefined && passwordsMatch(expectedPassword, provided)) {
    return true;
  }
  const method = request.method ?? 'UNKNOWN';
  const path = request.url ?? '';
  log(`${method} ${path} -> 401 (password)`);
  sendErrorResponse(response, 401, 'Unauthorized: invalid or missing Latchkey gateway password.');
  return false;
}

/**
 * Run an inbound request through the extensions. Resolves to true when the
 * request has been handled in some way and false if not.
 */
function runExtensions(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  extensions: readonly GatewayExtension[],
  deps: GatewayDependencies,
  settings: GatewayRequestSettings
): Promise<boolean> {
  if (extensions.length === 0) return Promise.resolve(false);

  const rawUrl = request.url ?? '';
  const method = (request.method ?? 'GET').toUpperCase();

  let permissionsConfigPath: string;
  try {
    permissionsConfigPath = resolveRequestPermissionsConfig(
      request.headers,
      deps.config.permissionsConfigPath,
      settings.permissionsOverrideSigningKey
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
    // types, so this branch is just defensive: a request listener is sync,
    // and rethrowing here would crash the process.
    deps.errorLog(
      `Unexpected error resolving permissions override for ${method} ${rawUrl}: ` +
        (error instanceof Error ? error.message : String(error))
    );
    sendErrorResponse(response, 500, 'Internal error');
    return Promise.resolve(true);
  }

  return dispatchExtensionRequest(request, response, extensions, deps, permissionsConfigPath);
}

export interface GatewayRequestHandlerOptions {
  /**
   * When not null, every request must present this value in the
   * `X-Latchkey-Gateway-Password` header.
   */
  readonly password: string | null;
  /** The largest request body the gateway reads, in bytes. */
  readonly maxBodySize: number;
  /** The extensions a request that is not the gateway's own is offered to, in order. */
  readonly extensions: readonly GatewayExtension[];
  /**
   * The `customMetadata` of every permission check for which Latchkey has no
   * account: a request offered to the extensions, and a proxied request that
   * Latchkey injects no credentials into. When omitted, none is passed, and
   * the permission library falls back to the DETENT_CUSTOM_METADATA
   * environment variable.
   */
  readonly defaultPermissionCheckMetadata?: Readonly<Record<string, unknown>>;
}

export interface GatewayRequestHandler {
  /**
   * Handle one request. Pass it to `http.createServer`, or call it from a
   * request listener of your own.
   */
  readonly handleRequest: (request: http.IncomingMessage, response: http.ServerResponse) => void;
  /** Run each extension's `start`, in order. Call it once, before the first request. */
  readonly start: () => Promise<void>;
  /**
   * Stop the gateway. Every call returns the promise of the first.
   *
   * From the first call a new request is answered 503. Each extension's
   * `stop` is called, in order. The requests in flight are given until the
   * deadline; then the curl process of every proxied request that has not
   * finished is killed and every response still open is destroyed. The
   * promise resolves when no request is being handled any more. It closes no
   * socket, because the handler owns none.
   */
  readonly stop: (options: { readonly deadlineMilliseconds: number }) => Promise<void>;
}

/**
 * Create the gateway's request handler over a runtime.
 *
 * Loads no extension from disk: the extensions are the ones passed in. Use
 * `loadExtensions` to pass those of a directory.
 */
export function createGatewayRequestHandler(
  runtime: LatchkeyRuntime,
  options: GatewayRequestHandlerOptions
): GatewayRequestHandler {
  const internals = getLatchkeyRuntimeInternals(runtime);
  const extensions = options.extensions;
  const abortController = new AbortController();
  const settings: GatewayRequestSettings = {
    maxBodySize: options.maxBodySize,
    permissionsOverrideSigningKey: internals.permissionsOverrideSigningKey,
    abortSignal: abortController.signal,
  };

  const defaultMetadata = options.defaultPermissionCheckMetadata;
  const checkPermission: GatewayDependencies['checkPermission'] =
    defaultMetadata === undefined
      ? internals.checkPermission
      : (request, configPath, doNotUseBuiltinSchemas, metadata) =>
          internals.checkPermission(
            request,
            configPath,
            doNotUseBuiltinSchemas,
            metadata ?? defaultMetadata
          );

  // What `stop` waits for: the handlers that have not returned, and the
  // responses that are not finished (an extension may return and keep its
  // response open, as a follow stream does).
  const pendingWork = new Set<Promise<unknown>>();
  const openResponses = new Set<http.ServerResponse>();
  let idleListeners: (() => void)[] = [];
  let stopPromise: Promise<void> | null = null;

  const isIdle = (): boolean => pendingWork.size === 0 && openResponses.size === 0;

  const notifyWhenIdle = (): void => {
    if (!isIdle()) return;
    const listeners = idleListeners;
    idleListeners = [];
    for (const listener of listeners) listener();
  };

  const track = (work: Promise<unknown>): void => {
    pendingWork.add(work);
    void work.finally(() => {
      pendingWork.delete(work);
      notifyWhenIdle();
    });
  };

  /** Resolves to whether the gateway became idle within the time given. */
  const waitUntilIdle = (timeoutMilliseconds: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (isIdle()) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => {
        resolve(isIdle());
      }, timeoutMilliseconds);
      idleListeners.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });

  const handleRequest = (request: http.IncomingMessage, response: http.ServerResponse): void => {
    const rawUrl = request.url ?? '';
    const method = request.method ?? 'UNKNOWN';

    if (stopPromise !== null) {
      runtime.log(`${method} ${rawUrl} -> 503 (shutting down)`);
      sendErrorResponse(response, 503, 'The Latchkey gateway is shutting down.', {
        Connection: 'close',
      });
      return;
    }

    openResponses.add(response);
    response.once('close', () => {
      openResponses.delete(response);
      notifyWhenIdle();
    });

    if (!enforcePassword(request, response, options.password, runtime.log)) {
      return;
    }

    // Health endpoint
    if (rawUrl === '/' && method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', version: runtime.version }));
      return;
    }

    // Build the registry from config.json as it reads now, so that
    // registering or deregistering a service while the gateway runs takes
    // effect without a restart — the way writes to the credential store and
    // to permissions.json already do. Each request gets its own: a shared one
    // would be rebuilt underneath requests already in flight.
    const requestDeps: GatewayDependencies = {
      registry: runtime.createServiceRegistry(),
      config: runtime.config,
      runCurlAsync: internals.runCurlAsync,
      checkPermission,
      log: runtime.log,
      errorLog: runtime.errorLog,
      version: runtime.version,
    };

    // Latchkey RPC endpoint
    if (rawUrl === '/latchkey/' || rawUrl === '/latchkey') {
      track(
        handleLatchkeyRequest(
          request,
          response,
          requestDeps,
          runtime.apiCredentialStore,
          runtime.encryptedStorage,
          settings
        ).catch((error: unknown) => {
          runtime.errorLog(
            `Unexpected error handling /latchkey/: ${error instanceof Error ? error.message : String(error)}`
          );
          if (!response.headersSent) {
            sendErrorResponse(response, 500, 'Internal error');
          }
        })
      );
      return;
    }

    // Gateway proxy endpoint
    if (rawUrl.startsWith(GATEWAY_PATH_PREFIX)) {
      const targetUrl = extractTargetUrl(rawUrl);
      if (targetUrl === null) {
        runtime.log(`${method} ${rawUrl.slice(GATEWAY_PATH_PREFIX.length)} -> 400`);
        sendErrorResponse(response, 400, ErrorMessages.couldNotExtractUrl);
        return;
      }

      track(
        handleGatewayRequest(
          request,
          response,
          targetUrl,
          requestDeps,
          runtime.apiCredentialStore,
          settings
        ).catch((error: unknown) => {
          runtime.errorLog(
            `Unexpected error handling ${method} ${targetUrl}: ${error instanceof Error ? error.message : String(error)}`
          );
          if (!response.headersSent) {
            sendErrorResponse(response, 502, ErrorMessages.upstreamRequestFailed);
          }
        })
      );
      return;
    }

    // Finally, try extensions (if any).
    track(
      runExtensions(request, response, extensions, requestDeps, settings)
        .then((handled) => {
          if (!handled && !response.headersSent) {
            response.writeHead(404);
            response.end();
          }
        })
        .catch((error: unknown) => {
          runtime.errorLog(
            `Unexpected error handling extension request ${method} ${rawUrl}: ` +
              (error instanceof Error ? error.message : String(error))
          );
          if (!response.headersSent) {
            sendErrorResponse(response, 500, 'Internal error');
          }
        })
    );
  };

  const runStop = async (deadlineMilliseconds: number): Promise<void> => {
    // A well-behaved stop() hook ends every response the extension is
    // holding open, which lets the gateway become idle well before the
    // deadline. The hooks count as work in flight, so the gateway is not
    // idle while one of them is still running.
    track(stopExtensions(extensions, runtime));

    if (await waitUntilIdle(deadlineMilliseconds)) {
      return;
    }

    abortController.abort();
    for (const response of openResponses) {
      response.destroy();
    }

    if (!(await waitUntilIdle(FORCED_END_GRACE_MS))) {
      runtime.errorLog(
        `Gave up waiting for ${String(pendingWork.size)} request handler(s) and ` +
          `${String(openResponses.size)} response(s) that outlived the gateway's shutdown.`
      );
    }
  };

  return {
    handleRequest,
    start: () => startExtensions(extensions),
    stop: ({ deadlineMilliseconds }) => {
      stopPromise ??= runStop(deadlineMilliseconds);
      return stopPromise;
    },
  };
}

export interface GatewayServer {
  readonly server: http.Server;
  readonly close: () => Promise<void>;
}

export interface GatewayServerOptions extends GatewayRequestHandlerOptions {
  readonly host: string;
  readonly port: number;
}

/**
 * Start the gateway on an HTTP server of its own.
 */
export async function startGateway(
  runtime: LatchkeyRuntime,
  options: GatewayServerOptions
): Promise<GatewayServer> {
  const handler = createGatewayRequestHandler(runtime, options);
  await handler.start();

  const server = http.createServer(handler.handleRequest);

  let closePromise: Promise<void> | null = null;
  const runClose = async (): Promise<void> => {
    runtime.log('Shutting down...');
    const serverClosed = new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    await handler.stop({ deadlineMilliseconds: SHUTDOWN_TIMEOUT_MS });
    // The handler is done with every request, so whatever connection is still
    // open is an idle one, which nothing is waiting on.
    server.closeAllConnections();
    await serverClosed;
  };
  const close = (): Promise<void> => {
    closePromise ??= runClose();
    return closePromise;
  };

  return new Promise((resolve, reject) => {
    server.on('error', reject);

    server.listen(options.port, options.host, () => {
      const passwordNote = options.password === null ? '' : ' (password authentication enabled)';
      runtime.log(
        `Latchkey gateway listening on ${options.host}:${String(options.port)}${passwordNote}`
      );
      resolve({ server, close });
    });
  });
}
