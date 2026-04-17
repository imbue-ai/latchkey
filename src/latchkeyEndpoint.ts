/**
 * HTTP handler for the /latchkey/ RPC endpoint.
 *
 * Accepts POST requests with a JSON body containing a command and optional params.
 * Dispatches to shared operation functions and returns a uniform response envelope.
 */

import * as http from 'node:http';
import { text } from 'node:stream/consumers';
import { z } from 'zod';
import type { ApiCredentialStore } from './apiCredentialStore.js';
import type { CliDependencies } from './cliCommands.js';
import type { EncryptedStorage } from './encryptedStorage.js';
import {
  servicesList,
  servicesInfo,
  authList,
  authBrowser,
  authBrowserPrepare,
  UnknownServiceError,
  BrowserNotConfiguredError,
  PreparationRequiredError,
} from './sharedOperations.js';
import {
  BrowserDisabledError,
  BrowserFlowsNotSupportedError,
  GraphicalEnvironmentNotFoundError,
} from './playwrightUtils.js';
import { LoginCancelledError, LoginFailedError } from './services/index.js';

const serviceNameParamsMessage = "missing required argument 'service_name'";
const serviceNameParams = z.object({
  serviceName: z.string({ required_error: serviceNameParamsMessage }),
}, { required_error: serviceNameParamsMessage });

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
  params: serviceNameParams,
});

const AuthListRequestSchema = z.object({
  command: z.literal('auth list'),
  params: z.object({}).optional(),
});

const AuthBrowserRequestSchema = z.object({
  command: z.literal('auth browser'),
  params: serviceNameParams,
});

const AuthBrowserPrepareRequestSchema = z.object({
  command: z.literal('auth browser-prepare'),
  params: serviceNameParams,
});

export const LatchkeyRequestSchema = z.discriminatedUnion('command', [
  ServicesListRequestSchema,
  ServicesInfoRequestSchema,
  AuthListRequestSchema,
  AuthBrowserRequestSchema,
  AuthBrowserPrepareRequestSchema,
]);

export type LatchkeyRequest = z.infer<typeof LatchkeyRequestSchema>;

const KNOWN_ERROR_CLASSES: readonly (abstract new (...args: never[]) => Error)[] = [
  UnknownServiceError,
  BrowserDisabledError,
  GraphicalEnvironmentNotFoundError,
  BrowserNotConfiguredError,
  BrowserFlowsNotSupportedError,
  PreparationRequiredError,
  LoginCancelledError,
  LoginFailedError,
];

function isKnownError(error: unknown): error is Error {
  return KNOWN_ERROR_CLASSES.some((ErrorClass) => error instanceof ErrorClass);
}

function sendJsonResponse(response: http.ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function sendSuccess(response: http.ServerResponse, result: unknown): void {
  sendJsonResponse(response, 200, { result });
}

function sendErrorResponse(response: http.ServerResponse, statusCode: number, message: string): void {
  sendJsonResponse(response, statusCode, { error: message });
}

function describeRequest(parsed: LatchkeyRequest): string {
  const command = parsed.command;
  if ('params' in parsed && parsed.params && 'serviceName' in parsed.params) {
    return `${command} ${parsed.params.serviceName}`;
  }
  return command;
}

async function dispatch(
  parsed: LatchkeyRequest,
  deps: CliDependencies,
  apiCredentialStore: ApiCredentialStore,
  encryptedStorage: EncryptedStorage,
): Promise<unknown> {
  switch (parsed.command) {
    case 'services list':
      return servicesList(
        deps.registry,
        apiCredentialStore,
        deps.config,
        parsed.params ?? {},
      );

    case 'services info':
      return servicesInfo(
        deps.registry,
        apiCredentialStore,
        deps.config,
        parsed.params.serviceName,
      );

    case 'auth list':
      return authList(deps.registry, apiCredentialStore);

    case 'auth browser':
      await authBrowser(
        deps.registry,
        apiCredentialStore,
        encryptedStorage,
        deps.config,
        parsed.params.serviceName,
      );
      return null;

    case 'auth browser-prepare':
      return authBrowserPrepare(
        deps.registry,
        apiCredentialStore,
        encryptedStorage,
        deps.config,
        parsed.params.serviceName,
      );
  }
}

export async function handleLatchkeyRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  deps: CliDependencies,
  apiCredentialStore: ApiCredentialStore,
  encryptedStorage: EncryptedStorage,
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
    const message = parseResult.error.errors.map((e) => {
      if (e.code === 'invalid_union_discriminator') {
        const received = (bodyJson as Record<string, unknown> | null)?.command;
        if (typeof received === 'string') {
          return `unknown command '${received}'`;
        }
        return 'missing required field \'command\'';
      }
      return e.message;
    }).join('; ');
    sendErrorResponse(response, 400, message);
    return;
  }

  const parsed = parseResult.data;
  const description = describeRequest(parsed);

  try {
    const result = await dispatch(parsed, deps, apiCredentialStore, encryptedStorage);
    deps.log(`POST /latchkey/ ${description} -> 200`);
    sendSuccess(response, result);
  } catch (error) {
    if (isKnownError(error)) {
      deps.log(`POST /latchkey/ ${description} -> 400 (error)`);
      sendErrorResponse(response, 400, error.message);
      return;
    }
    deps.errorLog(
      `Unexpected error handling POST /latchkey/ ${description}: ${error instanceof Error ? error.message : String(error)}`,
    );
    sendErrorResponse(response, 500, 'Internal error');
  }
}
