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
 * OAuth 2.0 credentials (access token, refresh token, client ID, and client secret).
 * Used by services that implement OAuth 2.0 authorization flows.
 */
export const OAuthCredentialsSchema = z.object({
  objectType: z.literal('oauth'),
  accessToken: z.string(),
  refreshToken: z.string(),
  clientId: z.string(),
  clientSecret: z.string(),
  accessTokenExpiresAt: z.string().optional(),
  refreshTokenExpiresAt: z.string().optional(),
});

export type OAuthCredentialsData = z.infer<typeof OAuthCredentialsSchema>;

export class OAuthCredentials implements ApiCredentials {
  readonly objectType = 'oauth' as const;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly accessTokenExpiresAt?: string;
  readonly refreshTokenExpiresAt?: string;

  constructor(
    accessToken: string,
    refreshToken: string,
    clientId: string,
    clientSecret: string,
    accessTokenExpiresAt?: string,
    refreshTokenExpiresAt?: string
  ) {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    if (accessTokenExpiresAt !== undefined) {
      this.accessTokenExpiresAt = accessTokenExpiresAt;
    }
    if (refreshTokenExpiresAt !== undefined) {
      this.refreshTokenExpiresAt = refreshTokenExpiresAt;
    }
  }

  asCurlArguments(): readonly string[] {
    return ['-H', `Authorization: Bearer ${this.accessToken}`];
  }

  toJSON(): OAuthCredentialsData {
    const result: OAuthCredentialsData = {
      objectType: this.objectType,
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
    };
    if (this.accessTokenExpiresAt !== undefined) {
      result.accessTokenExpiresAt = this.accessTokenExpiresAt;
    }
    if (this.refreshTokenExpiresAt !== undefined) {
      result.refreshTokenExpiresAt = this.refreshTokenExpiresAt;
    }
    return result;
  }

  static fromJSON(data: OAuthCredentialsData): OAuthCredentials {
    return new OAuthCredentials(
      data.accessToken,
      data.refreshToken,
      data.clientId,
      data.clientSecret,
      data.accessTokenExpiresAt,
      data.refreshTokenExpiresAt
    );
  }
}

/**
 * Union schema for all credential types.
 */
export const ApiCredentialsSchema = z.discriminatedUnion('objectType', [
  AuthorizationBearerSchema,
  AuthorizationBareSchema,
  SlackApiCredentialsSchema,
  OAuthCredentialsSchema,
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
  throw new ApiCredentialsSerializationError(`Unknown credential type: ${credentials.objectType}`);
}

export class ApiCredentialsSerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiCredentialsSerializationError';
  }
}
