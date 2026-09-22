/**
 * Serialization and deserialization of API credentials.
 *
 * This module is separate from base.ts to avoid circular dependencies:
 * service files import base types from base.ts, and this module imports
 * from both base.ts and service files.
 *
 * Which credentials can be read back is decided by a list of
 * {@link ApiCredentialsType}s. {@link BUILTIN_API_CREDENTIALS_TYPES} covers
 * everything Latchkey ships with and is the default; the CLI passes the
 * combined built-in and plugin list instead.
 */

import { z } from 'zod';
import {
  type ApiCredentials,
  type ApiCredentialsType,
  type SerializedApiCredentials,
  AuthorizationBare,
  AuthorizationBearer,
  OAuthCredentials,
  RawCurlCredentials,
} from './base.js';
import { AwsCredentials } from '../services/aws.js';
import { GoogleApiKeyCredentials } from '../services/google/base.js';
import { SlackApiCredentials } from '../services/slack.js';
import { TelegramBotCredentials } from '../services/telegram.js';
import { ZoomServerToServerCredentials } from '../services/zoom.js';
import { TailscaleCredentials } from '../services/tailscale.js';

export const BUILTIN_API_CREDENTIALS_TYPES: readonly ApiCredentialsType[] = [
  AuthorizationBearer,
  AuthorizationBare,
  SlackApiCredentials,
  OAuthCredentials,
  RawCurlCredentials,
  TelegramBotCredentials,
  AwsCredentials,
  GoogleApiKeyCredentials,
  ZoomServerToServerCredentials,
  TailscaleCredentials,
];

const OBJECT_TYPE_SCHEMA = z.object({ objectType: z.string() });

function findApiCredentialsType(
  objectType: string,
  apiCredentialsTypes: readonly ApiCredentialsType[]
): ApiCredentialsType | undefined {
  return apiCredentialsTypes.find((type) => type.objectType === objectType);
}

export function deserializeCredentials(
  data: unknown,
  apiCredentialsTypes: readonly ApiCredentialsType[] = BUILTIN_API_CREDENTIALS_TYPES
): ApiCredentials {
  const header = OBJECT_TYPE_SCHEMA.safeParse(data);
  if (!header.success) {
    throw new ApiCredentialsSerializationError('Credential data does not name an objectType.');
  }
  const objectType = header.data.objectType;
  const type = findApiCredentialsType(objectType, apiCredentialsTypes);
  if (type === undefined) {
    throw new ApiCredentialsSerializationError(
      `Unknown credential type '${objectType}'. Credentials of a type defined by a plugin ` +
        'can only be used while that plugin is installed.'
    );
  }
  try {
    return type.fromJSON(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiCredentialsSerializationError(
      `Invalid '${objectType}' credential data: ${message}`
    );
  }
}

/**
 * Refuses credentials that could not be read back afterwards, so that the
 * mistake surfaces when they are stored rather than when they are needed.
 */
export function serializeCredentials(
  credentials: ApiCredentials,
  apiCredentialsTypes: readonly ApiCredentialsType[] = BUILTIN_API_CREDENTIALS_TYPES
): SerializedApiCredentials {
  if (credentials.toJSON === undefined) {
    throw new ApiCredentialsSerializationError(
      `Credentials of type '${credentials.objectType}' are never stored.`
    );
  }
  if (findApiCredentialsType(credentials.objectType, apiCredentialsTypes) === undefined) {
    throw new ApiCredentialsSerializationError(
      `Unknown credential type '${credentials.objectType}'. A plugin defining its own ` +
        "credentials class has to list its type in 'apiCredentialsTypes'."
    );
  }
  return credentials.toJSON();
}

export class ApiCredentialsSerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiCredentialsSerializationError';
  }
}
