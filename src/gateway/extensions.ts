/**
 * Extensions: user-supplied HTTP handlers mounted on the gateway.
 *
 * The gateway scans `extensionsDirectory` for `*.mjs` files at startup
 * and dynamically imports each one. Each module's default export must be
 * a function `(request, response) => boolean | Promise<boolean>`:
 *
 *   - return `true` when the extension has handled the request (i.e. it
 *     has written / will write the response). The gateway will not consult
 *     any further extensions.
 *   - return `false` to defer to the next extension. The handler must not
 *     touch the response in this case.
 *
 * Extensions may additionally export optional named `start` and `stop`
 * functions (`() => void | Promise<void>`). The gateway invokes `start`
 * once for every loaded extension before it begins listening on the HTTP
 * port, and `stop` once at shutdown (just before `server.close()`), so
 * that extensions holding long-lived responses can release them and let
 * shutdown complete without waiting for the force-close timeout.
 *
 * Extensions only see Node's raw HTTP request / response. They do NOT have
 * access to credential storage, the curl-injection pipeline, or the service
 * registry. Each extension request is run through the same
 * `permissions.json` machinery as `/gateway/...` proxy requests, by
 * synthesising a request whose URL uses fixed placeholder values
 * (representing "this gateway") while preserving the inbound method, path,
 * and headers.
 */

import * as http from 'node:http';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CliDependencies } from '../cliCommands.js';
import { PermissionCheckError } from '../permissions.js';
import { RequestNotPermittedError } from '../curlInjection.js';
import { GATEWAY_INTERNAL_HEADERS, HOP_BY_HOP_HEADERS } from './gatewayEndpoint.js';

/**
 * Placeholder URL parts that stand in for "this gateway" when extension
 * requests are run through the permission check. They use RFC 2606's
 * reserved `.invalid` TLD so the synthetic URL is guaranteed never to
 * resolve to a real host. Detent schemas matching extension routes should
 * key on these exact values.
 */
export const EXTENSION_PLACEHOLDER_SCHEME = 'https';
export const EXTENSION_PLACEHOLDER_HOST = 'latchkey-self.invalid';
export const EXTENSION_PLACEHOLDER_PORT = 1;

const EXTENSION_FILE_SUFFIX = '.mjs';

export type ExtensionHandler = (
  request: http.IncomingMessage,
  response: http.ServerResponse
) => boolean | Promise<boolean>;

export type ExtensionLifecycleHook = () => void | Promise<void>;

export interface LoadedExtension {
  readonly handler: ExtensionHandler;
  readonly start?: ExtensionLifecycleHook;
  readonly stop?: ExtensionLifecycleHook;
  /** Absolute path of the file the handler was loaded from. */
  readonly sourceFile: string;
}

export class ExtensionLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtensionLoadError';
  }
}

export class ExtensionStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtensionStartError';
  }
}

function hasDefaultFunctionExport(
  value: unknown
): value is { readonly default: ExtensionHandler } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'default' in value &&
    typeof (value as { default: unknown }).default === 'function'
  );
}

/**
 * Read an optional named export from an imported module. Returns the
 * function when the export exists and is a function, `undefined` when the
 * export is absent or explicitly `null`/`undefined`, and throws
 * `ExtensionLoadError` when the export exists but is not callable.
 */
function extractOptionalLifecycleHook(
  importedModule: unknown,
  exportName: 'start' | 'stop',
  filePath: string
): ExtensionLifecycleHook | undefined {
  if (typeof importedModule !== 'object' || importedModule === null) return undefined;
  const value = (importedModule as Record<string, unknown>)[exportName];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'function') {
    throw new ExtensionLoadError(
      `Extension '${filePath}' exports '${exportName}' but it is not a function.`
    );
  }
  return value as ExtensionLifecycleHook;
}

/**
 * Load every extension module in `directory` and return the resulting
 * ordered list. Extensions are tried in alphabetical order of filename, so
 * the loader returns them in that order. Returns an empty list if the
 * directory does not exist. Throws `ExtensionLoadError` on the first file
 * that fails to import or has the wrong shape.
 */
export async function loadExtensions(directory: string): Promise<readonly LoadedExtension[]> {
  if (!existsSync(directory)) {
    return [];
  }
  if (!statSync(directory).isDirectory()) {
    return [];
  }

  const fileNames = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .filter((entry) => entry.name.endsWith(EXTENSION_FILE_SUFFIX))
    .map((entry) => entry.name)
    .sort();

  const extensions: LoadedExtension[] = [];
  for (const fileName of fileNames) {
    const filePath = join(directory, fileName);
    let importedModule: unknown;
    try {
      importedModule = (await import(pathToFileURL(filePath).href)) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ExtensionLoadError(`Failed to load extension '${filePath}': ${message}`);
    }
    if (!hasDefaultFunctionExport(importedModule)) {
      throw new ExtensionLoadError(
        `Extension '${filePath}' must export a default function ` +
          `(request, response) => boolean | Promise<boolean>.`
      );
    }
    const start = extractOptionalLifecycleHook(importedModule, 'start', filePath);
    const stop = extractOptionalLifecycleHook(importedModule, 'stop', filePath);
    extensions.push({
      handler: importedModule.default,
      start,
      stop,
      sourceFile: filePath,
    });
  }
  return extensions;
}

/**
 * Invoke every loaded extension's `start` hook sequentially, preserving
 * load order. Throws `ExtensionStartError` on the first failure; the
 * caller must avoid starting the HTTP server in that case.
 *
 * Extensions whose `start` already succeeded are NOT rolled back via
 * `stop` on failure - the gateway process is expected to exit on startup
 * failure, letting the OS reclaim any resources.
 */
export async function startExtensions(
  extensions: readonly LoadedExtension[]
): Promise<void> {
  for (const extension of extensions) {
    if (extension.start === undefined) continue;
    try {
      await extension.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ExtensionStartError(
        `Extension '${extension.sourceFile}' failed to start: ${message}`
      );
    }
  }
}

/**
 * Invoke every loaded extension's `stop` hook sequentially, preserving
 * load order. Errors are logged via `deps.errorLog` and otherwise
 * swallowed so that one misbehaving extension cannot block shutdown.
 */
export async function stopExtensions(
  extensions: readonly LoadedExtension[],
  deps: CliDependencies
): Promise<void> {
  for (const extension of extensions) {
    if (extension.stop === undefined) continue;
    try {
      await extension.stop();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.errorLog(
        `Extension '${extension.sourceFile}' stop hook threw: ${message}`
      );
    }
  }
}

/**
 * Build the synthetic `Request` fed to the permission check. The URL uses
 * fixed placeholder values for protocol/host/port (representing "this
 * gateway") with the inbound path and query string preserved verbatim. The
 * inbound method and headers are forwarded, minus hop-by-hop and
 * gateway-internal headers (so the password and permissions-override
 * headers cannot influence schema matching). The body is intentionally
 * omitted: the permission check operates on URL/method/headers only.
 */
function buildExtensionPermissionCheckRequest(request: http.IncomingMessage): Request {
  const url =
    `${EXTENSION_PLACEHOLDER_SCHEME}://${EXTENSION_PLACEHOLDER_HOST}` +
    `:${String(EXTENSION_PLACEHOLDER_PORT)}${request.url ?? ''}`;
  const headers = new Headers();
  const rawHeaders = request.rawHeaders;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]!;
    const value = rawHeaders[index + 1]!;
    const lowerName = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerName) || GATEWAY_INTERNAL_HEADERS.has(lowerName)) {
      continue;
    }
    headers.append(name, value);
  }
  return new Request(url, {
    method: (request.method ?? 'GET').toUpperCase(),
    headers,
  });
}

function sendErrorResponse(
  response: http.ServerResponse,
  statusCode: number,
  message: string
): void {
  if (response.headersSent) return;
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: message }));
}

/**
 * Run the permission check for an inbound extension request and offer it to
 * each loaded extension in order. Returns true when an extension claimed
 * the request (i.e. responded or threw). When false, no extension touched
 * the response and the caller is responsible for sending a fallback
 * (typically `404`).
 */
export async function dispatchExtensionRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  extensions: readonly LoadedExtension[],
  deps: CliDependencies,
  permissionsConfigPath: string
): Promise<boolean> {
  const method = (request.method ?? 'GET').toUpperCase();
  const pathAndQuery = request.url ?? '';

  let allowed: boolean;
  try {
    allowed = await deps.checkPermission(
      buildExtensionPermissionCheckRequest(request),
      permissionsConfigPath,
      deps.config.permissionsDoNotUseBuiltinSchemas
    );
  } catch (error) {
    if (error instanceof PermissionCheckError) {
      deps.log(`${method} ${pathAndQuery} -> 403 (extension)`);
      sendErrorResponse(response, 403, `Error: ${error.message}`);
      return true;
    }
    throw error;
  }
  if (!allowed) {
    const notPermitted = new RequestNotPermittedError();
    deps.log(`${method} ${pathAndQuery} -> 403 (extension)`);
    sendErrorResponse(response, 403, notPermitted.message);
    return true;
  }

  for (const extension of extensions) {
    let handled: boolean;
    try {
      handled = await extension.handler(request, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.errorLog(
        `Unexpected error in extension '${extension.sourceFile}' ` +
          `(${method} ${pathAndQuery}): ${message}`
      );
      sendErrorResponse(response, 500, 'Internal error');
      return true;
    }
    if (handled) {
      deps.log(`${method} ${pathAndQuery} -> ${String(response.statusCode)} (extension)`);
      return true;
    }
  }
  return false;
}
