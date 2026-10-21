/**
 * HTTP handler for the /latchkey/ RPC endpoint.
 *
 * Accepts POST requests with a JSON body containing a command and optional params.
 * Dispatches to shared operation functions and returns a uniform response envelope.
 */

import * as http from 'node:http';
import { text } from 'node:stream/consumers';
import { z } from 'zod';
import { ApiCredentialsUsageError } from '../apiCredentials/base.js';
import { AmbiguousAccountError, type ApiCredentialStore } from '../apiCredentials/store.js';
import type { CliDependencies } from '../cliCommands.js';
import {
  buildCurlDryRunReport,
  CredentialsExpiredError,
  NoCredentialsForServiceError,
  NoServiceForUrlError,
  prepareCurlInvocation,
  RequestNotPermittedError,
  UrlExtractionFailedError,
} from '../curlInjection.js';
import type { EncryptedStorage } from '../encryptedStorage.js';
import { PermissionCheckError } from '../permissions.js';
import { buildCurlArguments, type GatewayOptions } from './gatewayEndpoint.js';
import {
  InvalidPermissionsOverrideError,
  PermissionsOverrideFileMissingError,
  resolveRequestPermissionsConfig,
} from './permissionsOverride.js';
import {
  servicesList,
  servicesInfo,
  authList,
  authBrowser,
  authBrowserPrepare,
  prepareService,
  UnknownServiceError,
  AccountNotFoundError,
  BrowserNotConfiguredError,
  PreparationRequiredError,
} from '../sharedOperations.js';
import {
  BrowserDisabledError,
  BrowserFlowsNotSupportedError,
  GraphicalEnvironmentNotFoundError,
} from '../playwrightUtils.js';
import {
  LoginCancelledError,
  LoginFailedError,
  PrepareInputInvalidError,
  PrepareNotSupportedError,
} from '../services/index.js';

const serviceNameParamsMessage = "missing required argument 'service_name'";
const serviceNameParams = z.object(
  {
    serviceName: z.string({ required_error: serviceNameParamsMessage }),
  },
  { required_error: serviceNameParamsMessage }
);

const ServicesListRequestSchema = z.object({
  command: z.literal('services list'),
  params: z
    .object({
      builtin: z.boolean().optional(),
      viable: z.boolean().optional(),
    })
    .optional(),
});

const ServicesInfoRequestSchema = z.object({
  command: z.literal('services info'),
  params: serviceNameParams.extend({
    offline: z.boolean().optional(),
  }),
});

const AuthListRequestSchema = z.object({
  command: z.literal('auth list'),
  params: z
    .object({
      offline: z.boolean().optional(),
    })
    .optional(),
});

const AuthBrowserRequestSchema = z.object({
  command: z.literal('auth browser'),
  params: serviceNameParams.extend({
    account: z.string().optional(),
    strict: z.boolean().optional(),
  }),
});

const AuthBrowserPrepareRequestSchema = z.object({
  command: z.literal('auth browser-prepare'),
  params: serviceNameParams,
});

const PrepareRequestSchema = z.object({
  command: z.literal('auth prepare'),
  params: serviceNameParams.extend({
    json: z.string(),
  }),
});

/**
 * The request `latchkey --dry-run curl` would send, already parsed out of the
 * curl arguments on the client. The gateway turns it back into curl arguments
 * the same way the `/gateway/` proxy does for a real request, so the report
 * reflects what a real call through this gateway would do.
 */
const CurlDryRunRequestSchema = z.object({
  command: z.literal('curl dry-run'),
  params: z.object({
    method: z.string(),
    url: z.string(),
    headers: z.record(z.string()),
    bodyBase64: z.string().nullable(),
    account: z.string().optional(),
  }),
});

export const LatchkeyRequestSchema = z.discriminatedUnion('command', [
  ServicesListRequestSchema,
  ServicesInfoRequestSchema,
  AuthListRequestSchema,
  AuthBrowserRequestSchema,
  AuthBrowserPrepareRequestSchema,
  PrepareRequestSchema,
  CurlDryRunRequestSchema,
]);

export type LatchkeyRequest = z.infer<typeof LatchkeyRequestSchema>;

const KNOWN_ERROR_CLASSES: readonly (abstract new (...args: never[]) => Error)[] = [
  UnknownServiceError,
  AccountNotFoundError,
  BrowserDisabledError,
  GraphicalEnvironmentNotFoundError,
  BrowserNotConfiguredError,
  BrowserFlowsNotSupportedError,
  PreparationRequiredError,
  LoginCancelledError,
  LoginFailedError,
  PrepareNotSupportedError,
  PrepareInputInvalidError,
  PermissionsOverrideFileMissingError,
  UrlExtractionFailedError,
  NoServiceForUrlError,
  NoCredentialsForServiceError,
  CredentialsExpiredError,
  AmbiguousAccountError,
  ApiCredentialsUsageError,
];

/**
 * The HTTP status a known error maps to, or null for an unexpected error.
 * Permission and override failures use the same statuses the `/gateway/`
 * proxy uses for them, so a client can tell them apart from other failures.
 */
function statusCodeForKnownError(error: unknown): number | null {
  if (error instanceof RequestNotPermittedError || error instanceof PermissionCheckError) {
    return 403;
  }
  if (error instanceof InvalidPermissionsOverrideError) {
    return 401;
  }
  if (KNOWN_ERROR_CLASSES.some((ErrorClass) => error instanceof ErrorClass)) {
    return 400;
  }
  return null;
}

function sendJsonResponse(response: http.ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function sendSuccess(response: http.ServerResponse, result: unknown): void {
  sendJsonResponse(response, 200, { result });
}

function sendErrorResponse(
  response: http.ServerResponse,
  statusCode: number,
  message: string
): void {
  sendJsonResponse(response, statusCode, { error: message, latchkeyError: true });
}

function describeRequest(parsed: LatchkeyRequest): string {
  const command = parsed.command;
  if (parsed.command === 'curl dry-run') {
    return `${command} ${parsed.params.method} ${parsed.params.url}`;
  }
  if ('params' in parsed && parsed.params && 'serviceName' in parsed.params) {
    return `${command} ${parsed.params.serviceName}`;
  }
  return command;
}

async function curlDryRun(
  params: z.infer<typeof CurlDryRunRequestSchema>['params'],
  requestHeaders: http.IncomingHttpHeaders,
  deps: CliDependencies,
  apiCredentialStore: ApiCredentialStore,
  options: GatewayOptions
): Promise<unknown> {
  const permissionsConfigPath = resolveRequestPermissionsConfig(
    requestHeaders,
    deps.config.permissionsConfigPath,
    options.permissionsOverrideSigningKey
  );
  const body = params.bodyBase64 === null ? null : Buffer.from(params.bodyBase64, 'base64');
  const curlArguments = buildCurlArguments(
    params.method,
    new Map(Object.entries(params.headers)),
    params.url,
    body !== null
  );
  const preparation = await prepareCurlInvocation(
    curlArguments,
    apiCredentialStore,
    {
      registry: deps.registry,
      checkPermission: deps.checkPermission,
      permissionsConfigPath,
      permissionsDoNotUseBuiltinSchemas: deps.config.permissionsDoNotUseBuiltinSchemas,
      passthroughUnknown: deps.config.passthroughUnknown,
      credentialsRefreshDisabled: deps.config.credentialsRefreshDisabled,
      diagnosticHeaders: deps.config.diagnosticHeaders,
      account: params.account,
    },
    body
  );
  return buildCurlDryRunReport(preparation);
}

async function dispatch(
  parsed: LatchkeyRequest,
  requestHeaders: http.IncomingHttpHeaders,
  deps: CliDependencies,
  apiCredentialStore: ApiCredentialStore,
  encryptedStorage: EncryptedStorage,
  options: GatewayOptions
): Promise<unknown> {
  switch (parsed.command) {
    case 'services list':
      return servicesList(deps.registry, apiCredentialStore, deps.config, parsed.params ?? {});

    case 'services info':
      return servicesInfo(
        deps.registry,
        apiCredentialStore,
        deps.config,
        parsed.params.serviceName,
        parsed.params.offline ?? false
      );

    case 'auth list':
      return authList(
        deps.registry,
        apiCredentialStore,
        deps.config,
        parsed.params?.offline ?? false
      );

    case 'auth browser':
      return authBrowser(
        deps.registry,
        apiCredentialStore,
        encryptedStorage,
        deps.config,
        parsed.params.serviceName,
        parsed.params.account,
        { strict: parsed.params.strict ?? false }
      );

    case 'auth browser-prepare':
      return authBrowserPrepare(
        deps.registry,
        apiCredentialStore,
        encryptedStorage,
        deps.config,
        parsed.params.serviceName
      );

    case 'auth prepare':
      return prepareService(
        deps.registry,
        apiCredentialStore,
        parsed.params.serviceName,
        parsed.params.json
      );

    case 'curl dry-run':
      return curlDryRun(parsed.params, requestHeaders, deps, apiCredentialStore, options);
  }
}

export async function handleLatchkeyRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  deps: CliDependencies,
  apiCredentialStore: ApiCredentialStore,
  encryptedStorage: EncryptedStorage,
  options: GatewayOptions
): Promise<void> {
  if (request.method !== 'POST') {
    sendErrorResponse(response, 405, 'Method not allowed. Use POST.');
    return;
  }

  const bodyText = await text(request);

  let bodyJson: unknown;
  try {
    bodyJson = JSON.parse(bodyText) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      sendErrorResponse(response, 400, `Invalid JSON: ${error.message}`);
      return;
    }
    throw error;
  }

  const parseResult = LatchkeyRequestSchema.safeParse(bodyJson);
  if (!parseResult.success) {
    const message = parseResult.error.errors
      .map((e) => {
        if (e.code === 'invalid_union_discriminator') {
          const received = (bodyJson as Record<string, unknown> | null)?.command;
          if (typeof received === 'string') {
            return `unknown command '${received}'`;
          }
          return "missing required field 'command'";
        }
        return e.message;
      })
      .join('; ');
    sendErrorResponse(response, 400, message);
    return;
  }

  const parsed = parseResult.data;
  const description = describeRequest(parsed);

  try {
    const result = await dispatch(
      parsed,
      request.headers,
      deps,
      apiCredentialStore,
      encryptedStorage,
      options
    );
    deps.log(`POST /latchkey/ ${description} -> 200`);
    sendSuccess(response, result);
  } catch (error) {
    const statusCode = statusCodeForKnownError(error);
    if (statusCode !== null && error instanceof Error) {
      deps.log(`POST /latchkey/ ${description} -> ${String(statusCode)} (error)`);
      sendErrorResponse(response, statusCode, error.message);
      return;
    }
    deps.errorLog(
      `Unexpected error handling POST /latchkey/ ${description}: ${error instanceof Error ? error.message : String(error)}`
    );
    sendErrorResponse(response, 500, 'Internal error');
  }
}
