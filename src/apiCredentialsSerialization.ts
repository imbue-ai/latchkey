/**
 * Serialization and deserialization of API credentials.
 *
 * This module is separate from apiCredentials.ts to avoid circular dependencies:
 * service files import base types from apiCredentials.ts, and this module imports
 * from both apiCredentials.ts and service files.
 */

import { z } from 'zod';
import {
  type ApiCredentials,
  AuthorizationBare,
  AuthorizationBareSchema,
  AuthorizationBearer,
  AuthorizationBearerSchema,
  OAuthCredentials,
  OAuthCredentialsSchema,
  RawCurlCredentials,
  RawCurlCredentialsSchema,
} from './apiCredentials.js';
import { AwsCredentials, AwsCredentialsSchema } from './services/aws.js';
import { SlackApiCredentials, SlackApiCredentialsSchema } from './services/slack.js';
import { TelegramBotCredentials, TelegramBotCredentialsSchema } from './services/telegram.js';

/**
 * Union schema for all credential types.
 */
export const ApiCredentialsSchema = z.discriminatedUnion('objectType', [
  AuthorizationBearerSchema,
  AuthorizationBareSchema,
  SlackApiCredentialsSchema,
  OAuthCredentialsSchema,
  RawCurlCredentialsSchema,
  TelegramBotCredentialsSchema,
  AwsCredentialsSchema,
]);

export type ApiCredentialsData = z.infer<typeof ApiCredentialsSchema>;

/**
 * Deserialize credentials from JSON data.
 */
export function deserializeCredentials(data: ApiCredentialsData): ApiCredentials {
  switch (data.objectType) {
    case 'authorizationBearer':
      return AuthorizationBearer.fromJSON(data);
    case 'authorizationBare':
      return AuthorizationBare.fromJSON(data);
    case 'slack':
      return SlackApiCredentials.fromJSON(data);
    case 'oauth':
      return OAuthCredentials.fromJSON(data);
    case 'rawCurl':
      return RawCurlCredentials.fromJSON(data);
    case 'telegramBot':
      return TelegramBotCredentials.fromJSON(data);
    case 'aws':
      return AwsCredentials.fromJSON(data);
    default: {
      const exhaustiveCheck: never = data;
      throw new ApiCredentialsSerializationError(
        `Unknown credential type: ${(exhaustiveCheck as { objectType: string }).objectType}`
      );
    }
  }
}

/**
 * Serialize credentials to JSON data.
 */
export function serializeCredentials(credentials: ApiCredentials): ApiCredentialsData {
  if (credentials instanceof AuthorizationBearer) {
    return credentials.toJSON();
  }
  if (credentials instanceof AuthorizationBare) {
    return credentials.toJSON();
  }
  if (credentials instanceof SlackApiCredentials) {
    return credentials.toJSON();
  }
  if (credentials instanceof OAuthCredentials) {
    return credentials.toJSON();
  }
  if (credentials instanceof RawCurlCredentials) {
    return credentials.toJSON();
  }
  if (credentials instanceof TelegramBotCredentials) {
    return credentials.toJSON();
  }
  if (credentials instanceof AwsCredentials) {
    return credentials.toJSON();
  }
  throw new ApiCredentialsSerializationError(`Unknown credential type: ${credentials.objectType}`);
}

export class ApiCredentialsSerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiCredentialsSerializationError';
  }
}
