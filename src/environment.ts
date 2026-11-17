/**
 * Access to Latchkey's environment variables.
 *
 * Besides the process environment, values can be supplied as a JSON object
 * (variable name -> string value) through an inherited file descriptor named
 * by LATCHKEY_ENV_OVERRIDES_FD. Unlike the process environment, such values
 * are not visible to other processes and are not inherited by child processes.
 */

import { closeSync, readFileSync } from 'node:fs';
import { z } from 'zod';

export const LATCHKEY_ENV_OVERRIDES_FD_ENV_VAR = 'LATCHKEY_ENV_OVERRIDES_FD';

export const LATCHKEY_DIRECTORY_ENV_VAR = 'LATCHKEY_DIRECTORY';
export const LATCHKEY_CURL_ENV_VAR = 'LATCHKEY_CURL';
export const LATCHKEY_ENCRYPTION_KEY_ENV_VAR = 'LATCHKEY_ENCRYPTION_KEY';
export const LATCHKEY_KEYRING_SERVICE_NAME_ENV_VAR = 'LATCHKEY_KEYRING_SERVICE_NAME';
export const LATCHKEY_KEYRING_ACCOUNT_NAME_ENV_VAR = 'LATCHKEY_KEYRING_ACCOUNT_NAME';
export const LATCHKEY_DISABLE_BROWSER_ENV_VAR = 'LATCHKEY_DISABLE_BROWSER';
export const LATCHKEY_EPHEMERAL_BROWSER_ENV_VAR = 'LATCHKEY_EPHEMERAL_BROWSER';
export const LATCHKEY_DISABLE_COUNTING_ENV_VAR = 'LATCHKEY_DISABLE_COUNTING';
export const LATCHKEY_DISABLE_CREDENTIALS_REFRESH_ENV_VAR = 'LATCHKEY_DISABLE_CREDENTIALS_REFRESH';
export const LATCHKEY_PERMISSIONS_CONFIG_ENV_VAR = 'LATCHKEY_PERMISSIONS_CONFIG';
export const LATCHKEY_PERMISSIONS_DO_NOT_USE_BUILTIN_SCHEMAS_ENV_VAR =
  'LATCHKEY_PERMISSIONS_DO_NOT_USE_BUILTIN_SCHEMAS';
export const LATCHKEY_PASSTHROUGH_UNKNOWN_ENV_VAR = 'LATCHKEY_PASSTHROUGH_UNKNOWN';
export const LATCHKEY_HIDE_BUILTIN_SERVICES_ENV_VAR = 'LATCHKEY_HIDE_BUILTIN_SERVICES';
export const LATCHKEY_DIAGNOSTIC_HEADERS_ENV_VAR = 'LATCHKEY_DIAGNOSTIC_HEADERS';
export const LATCHKEY_GATEWAY_ENV_VAR = 'LATCHKEY_GATEWAY';
export const LATCHKEY_GATEWAY_LISTEN_HOST_ENV_VAR = 'LATCHKEY_GATEWAY_LISTEN_HOST';
export const LATCHKEY_GATEWAY_LISTEN_PORT_ENV_VAR = 'LATCHKEY_GATEWAY_LISTEN_PORT';
export const LATCHKEY_GATEWAY_PASSWORD_ENV_VAR = 'LATCHKEY_GATEWAY_PASSWORD';
export const LATCHKEY_GATEWAY_LISTEN_PASSWORD_ENV_VAR = 'LATCHKEY_GATEWAY_LISTEN_PASSWORD';
export const LATCHKEY_GATEWAY_PERMISSIONS_OVERRIDE_ENV_VAR =
  'LATCHKEY_GATEWAY_PERMISSIONS_OVERRIDE';
export const LATCHKEY_APP_NAME_PREFIX_ENV_VAR = 'LATCHKEY_APP_NAME_PREFIX';
export const LATCHKEY_DEBUG_ENV_VAR = 'LATCHKEY_DEBUG';
export const LATCHKEY_DISABLE_SPINNER_ENV_VAR = 'LATCHKEY_DISABLE_SPINNER';

/**
 * The variables that may be supplied through LATCHKEY_ENV_OVERRIDES_FD.
 */
export const OVERRIDABLE_ENVIRONMENT_VARIABLE_NAMES: readonly string[] = [
  LATCHKEY_DIRECTORY_ENV_VAR,
  LATCHKEY_CURL_ENV_VAR,
  LATCHKEY_ENCRYPTION_KEY_ENV_VAR,
  LATCHKEY_KEYRING_SERVICE_NAME_ENV_VAR,
  LATCHKEY_KEYRING_ACCOUNT_NAME_ENV_VAR,
  LATCHKEY_DISABLE_BROWSER_ENV_VAR,
  LATCHKEY_EPHEMERAL_BROWSER_ENV_VAR,
  LATCHKEY_DISABLE_COUNTING_ENV_VAR,
  LATCHKEY_DISABLE_CREDENTIALS_REFRESH_ENV_VAR,
  LATCHKEY_PERMISSIONS_CONFIG_ENV_VAR,
  LATCHKEY_PERMISSIONS_DO_NOT_USE_BUILTIN_SCHEMAS_ENV_VAR,
  LATCHKEY_PASSTHROUGH_UNKNOWN_ENV_VAR,
  LATCHKEY_HIDE_BUILTIN_SERVICES_ENV_VAR,
  LATCHKEY_DIAGNOSTIC_HEADERS_ENV_VAR,
  LATCHKEY_GATEWAY_ENV_VAR,
  LATCHKEY_GATEWAY_LISTEN_HOST_ENV_VAR,
  LATCHKEY_GATEWAY_LISTEN_PORT_ENV_VAR,
  LATCHKEY_GATEWAY_PASSWORD_ENV_VAR,
  LATCHKEY_GATEWAY_LISTEN_PASSWORD_ENV_VAR,
  LATCHKEY_GATEWAY_PERMISSIONS_OVERRIDE_ENV_VAR,
  LATCHKEY_APP_NAME_PREFIX_ENV_VAR,
  LATCHKEY_DEBUG_ENV_VAR,
  LATCHKEY_DISABLE_SPINNER_ENV_VAR,
];

export class InvalidEnvironmentOverridesError extends Error {
  constructor(reason: string) {
    super(`Invalid ${LATCHKEY_ENV_OVERRIDES_FD_ENV_VAR}: ${reason}`);
    this.name = 'InvalidEnvironmentOverridesError';
  }
}

export type EnvironmentOverrides = Readonly<Record<string, string>>;

const EnvironmentOverridesSchema = z.record(z.string(), z.string());

/**
 * Parse the JSON document read from the overrides file descriptor.
 * Anything but an object mapping known variable names to strings is rejected,
 * so that a typo cannot silently drop e.g. an encryption key.
 */
export function parseEnvironmentOverrides(content: string): EnvironmentOverrides {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    throw new InvalidEnvironmentOverridesError('the content is not valid JSON.');
  }
  const parsed = EnvironmentOverridesSchema.safeParse(data);
  if (!parsed.success) {
    throw new InvalidEnvironmentOverridesError(
      'the content must be a JSON object mapping environment variable names to strings.'
    );
  }
  const unknownNames = Object.keys(parsed.data).filter(
    (name) => !OVERRIDABLE_ENVIRONMENT_VARIABLE_NAMES.includes(name)
  );
  if (unknownNames.length > 0) {
    throw new InvalidEnvironmentOverridesError(
      `unsupported variable name(s): ${unknownNames.join(', ')}.`
    );
  }
  return parsed.data;
}

function readAndCloseFileDescriptor(fileDescriptor: number): string {
  try {
    return readFileSync(fileDescriptor, 'utf-8');
  } finally {
    closeSync(fileDescriptor);
  }
}

/**
 * Read the overrides from the file descriptor named by `fileDescriptorValue`
 * (the raw value of LATCHKEY_ENV_OVERRIDES_FD). The descriptor is read until
 * end-of-file and then closed. An unset or empty value means no overrides.
 */
export function loadEnvironmentOverrides(
  fileDescriptorValue: string | undefined,
  readFileDescriptor: (fileDescriptor: number) => string = readAndCloseFileDescriptor
): EnvironmentOverrides {
  if (fileDescriptorValue === undefined || fileDescriptorValue === '') {
    return {};
  }
  if (!/^\d+$/.test(fileDescriptorValue)) {
    throw new InvalidEnvironmentOverridesError(
      `'${fileDescriptorValue}' is not a file descriptor number.`
    );
  }
  let content: string;
  try {
    content = readFileDescriptor(Number(fileDescriptorValue));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new InvalidEnvironmentOverridesError(
      `cannot read file descriptor ${fileDescriptorValue} (${detail}).`
    );
  }
  return parseEnvironmentOverrides(content);
}

function loadProcessEnvironmentOverrides(): EnvironmentOverrides {
  const fileDescriptorValue = process.env[LATCHKEY_ENV_OVERRIDES_FD_ENV_VAR];
  // The descriptor can only be read once, so child processes (and their
  // Latchkey invocations) must not be pointed at it again.
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete process.env[LATCHKEY_ENV_OVERRIDES_FD_ENV_VAR];
  return loadEnvironmentOverrides(fileDescriptorValue);
}

const ENVIRONMENT_OVERRIDES = loadProcessEnvironmentOverrides();

/**
 * Look up an environment variable; overrides supplied through
 * LATCHKEY_ENV_OVERRIDES_FD take precedence over the process environment.
 */
export function getEnvironmentVariable(name: string): string | undefined {
  return ENVIRONMENT_OVERRIDES[name] ?? process.env[name];
}
