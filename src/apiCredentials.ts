/**
 * API credentials types and utilities for authentication with various services.
 */

import { z } from 'zod';

export enum ApiCredentialStatus {
  Missing = 'missing',
  Valid = 'valid',
  Invalid = 'invalid',
}

/**
 * Base interface for all API credentials.
 * Each credential type must specify how to convert itself to curl arguments.
 */
export interface ApiCredentials {
  readonly objectType: string;
  asCurlArguments(): readonly string[];
}

/**
 * Bearer token authentication (Authorization: Bearer <token>).
 */
export const AuthorizationBearerSchema = z.object({
  objectType: z.literal('authorizationBearer'),
  token: z.string(),
});

export type AuthorizationBearerData = z.infer<typeof AuthorizationBearerSchema>;

export class AuthorizationBearer implements ApiCredentials {
  readonly objectType = 'authorizationBearer' as const;
  readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  asCurlArguments(): readonly string[] {
    return ['-H', `Authorization: Bearer ${this.token}`];
  }

  toJSON(): AuthorizationBearerData {
    return {
      objectType: this.objectType,
      token: this.token,
    };
  }

  static fromJSON(data: AuthorizationBearerData): AuthorizationBearer {
    return new AuthorizationBearer(data.token);
  }
}

/**
 * Raw authorization header (Authorization: <token>).
 */
export const AuthorizationBareSchema = z.object({
  objectType: z.literal('authorizationBare'),
  token: z.string(),
});

export type AuthorizationBareData = z.infer<typeof AuthorizationBareSchema>;

export class AuthorizationBare implements ApiCredentials {
  readonly objectType = 'authorizationBare' as const;
  readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  asCurlArguments(): readonly string[] {
    return ['-H', `Authorization: ${this.token}`];
  }

  toJSON(): AuthorizationBareData {
    return {
      objectType: this.objectType,
      token: this.token,
    };
  }

  static fromJSON(data: AuthorizationBareData): AuthorizationBare {
    return new AuthorizationBare(data.token);
  }
}

/**
 * Slack-specific credentials (token + d cookie).
 */
export const SlackApiCredentialsSchema = z.object({
  objectType: z.literal('slack'),
  token: z.string(),
  dCookie: z.string(),
});

export type SlackApiCredentialsData = z.infer<typeof SlackApiCredentialsSchema>;

export class SlackApiCredentials implements ApiCredentials {
  readonly objectType = 'slack' as const;
  readonly token: string;
  readonly dCookie: string;

  constructor(token: string, dCookie: string) {
    this.token = token;
    this.dCookie = dCookie;
  }

  asCurlArguments(): readonly string[] {
    return ['-H', `Authorization: Bearer ${this.token}`, '-H', `Cookie: d=${this.dCookie}`];
  }

  toJSON(): SlackApiCredentialsData {
    return {
      objectType: this.objectType,
      token: this.token,
      dCookie: this.dCookie,
    };
  }

  static fromJSON(data: SlackApiCredentialsData): SlackApiCredentials {
    return new SlackApiCredentials(data.token, data.dCookie);
  }
}

/**
 * Databricks-specific credentials (all cookies + CSRF token).
 */
export const DatabricksApiCredentialsSchema = z.object({
  objectType: z.literal('databricks'),
  cookies: z.string(), // All cookies as a single string for curl -b
  csrfToken: z.string(),
  workspaceUrl: z.string(),
});

export type DatabricksApiCredentialsData = z.infer<typeof DatabricksApiCredentialsSchema>;

export class DatabricksApiCredentials implements ApiCredentials {
  readonly objectType = 'databricks' as const;

  constructor(
    readonly cookies: string,
    readonly csrfToken: string,
    readonly workspaceUrl: string
  ) {}

  asCurlArguments(): readonly string[] {
    const args: string[] = ['-b', this.cookies];
    if (this.csrfToken) {
      args.push('-H', `x-csrf-token: ${this.csrfToken}`);
    }
    return args;
  }

  toJSON(): DatabricksApiCredentialsData {
    return {
      objectType: this.objectType,
      cookies: this.cookies,
      csrfToken: this.csrfToken,
      workspaceUrl: this.workspaceUrl,
    };
  }

  static fromJSON(data: DatabricksApiCredentialsData): DatabricksApiCredentials {
    return new DatabricksApiCredentials(data.cookies, data.csrfToken, data.workspaceUrl);
  }
}

/**
 * Union schema for all credential types.
 */
export const ApiCredentialsSchema = z.discriminatedUnion('objectType', [
  AuthorizationBearerSchema,
  AuthorizationBareSchema,
  SlackApiCredentialsSchema,
  DatabricksApiCredentialsSchema,
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
    case 'databricks':
      return DatabricksApiCredentials.fromJSON(data);
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
  if (credentials instanceof DatabricksApiCredentials) {
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
