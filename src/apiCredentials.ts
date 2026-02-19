/**
 * Base API credentials types and generic credential implementations.
 */

import { z } from 'zod';

export enum ApiCredentialStatus {
  Missing = 'missing',
  Valid = 'valid',
  Invalid = 'invalid',
}

/**
 * Base interface for all API credentials.
 * Each credential type must specify how to inject itself into a curl call.
 */
export interface ApiCredentials {
  readonly objectType: string;
  /**
   * Inject credentials into a curl call by modifying the given arguments array.
   * Implementations may add headers, change the URL, or transform arguments in any way.
   */
  injectIntoCurlCall(curlArguments: readonly string[]): readonly string[];
  /**
   * Check if the credentials are expired.
   * Returns true if expired, false if valid, or undefined if expiration is unknown.
   */
  isExpired(): boolean | undefined;
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

  injectIntoCurlCall(curlArguments: readonly string[]): readonly string[] {
    return ['-H', `Authorization: Bearer ${this.token}`, ...curlArguments];
  }

  isExpired(): boolean | undefined {
    return undefined;
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

  injectIntoCurlCall(curlArguments: readonly string[]): readonly string[] {
    return ['-H', `Authorization: ${this.token}`, ...curlArguments];
  }

  isExpired(): boolean | undefined {
    return undefined;
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
 * Raw curl arguments stored directly as credentials.
 * Allows users to manually set arbitrary curl arguments for a service.
 */
export const RawCurlCredentialsSchema = z.object({
  objectType: z.literal('rawCurl'),
  curlArguments: z.array(z.string()),
});

export type RawCurlCredentialsData = z.infer<typeof RawCurlCredentialsSchema>;

export class RawCurlCredentials implements ApiCredentials {
  readonly objectType = 'rawCurl' as const;
  readonly curlArguments: readonly string[];

  constructor(curlArguments: readonly string[]) {
    this.curlArguments = curlArguments;
  }

  injectIntoCurlCall(curlArguments: readonly string[]): readonly string[] {
    return [...this.curlArguments, ...curlArguments];
  }

  isExpired(): boolean | undefined {
    return undefined;
  }

  toJSON(): RawCurlCredentialsData {
    return {
      objectType: this.objectType,
      curlArguments: [...this.curlArguments],
    };
  }

  static fromJSON(data: RawCurlCredentialsData): RawCurlCredentials {
    return new RawCurlCredentials(data.curlArguments);
  }
}

/**
 * OAuth 2.0 credentials (access token, refresh token, client ID, and client secret).
 * Used by services that implement OAuth 2.0 authorization flows.
 * Token attributes are optional - when only clientId and clientSecret are present,
 * this represents credentials from the prepare() step before obtaining user tokens.
 */
export const OAuthCredentialsSchema = z.object({
  objectType: z.literal('oauth'),
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  clientId: z.string(),
  clientSecret: z.string(),
  accessTokenExpiresAt: z.string().optional(),
  refreshTokenExpiresAt: z.string().optional(),
});

export type OAuthCredentialsData = z.infer<typeof OAuthCredentialsSchema>;

export class OAuthCredentials implements ApiCredentials {
  readonly objectType = 'oauth' as const;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly accessTokenExpiresAt?: string;
  readonly refreshTokenExpiresAt?: string;

  constructor(
    clientId: string,
    clientSecret: string,
    accessToken?: string,
    refreshToken?: string,
    accessTokenExpiresAt?: string,
    refreshTokenExpiresAt?: string
  ) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.accessTokenExpiresAt = accessTokenExpiresAt;
    this.refreshTokenExpiresAt = refreshTokenExpiresAt;
  }

  injectIntoCurlCall(curlArguments: readonly string[]): readonly string[] {
    if (this.accessToken === undefined) {
      throw new ApiCredentialsUsageError(
        'OAuth credentials missing access token. Run login to obtain access tokens.'
      );
    }
    return ['-H', `Authorization: Bearer ${this.accessToken}`, ...curlArguments];
  }

  isExpired(): boolean | undefined {
    if (this.accessTokenExpiresAt === undefined) {
      return undefined;
    }
    const expirationDate = new Date(this.accessTokenExpiresAt);
    return Date.now() >= expirationDate.getTime();
  }

  toJSON(): OAuthCredentialsData {
    const result: OAuthCredentialsData = {
      objectType: this.objectType,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      accessTokenExpiresAt: this.accessTokenExpiresAt,
      refreshTokenExpiresAt: this.refreshTokenExpiresAt,
    };
    return result;
  }

  static fromJSON(data: OAuthCredentialsData): OAuthCredentials {
    return new OAuthCredentials(
      data.clientId,
      data.clientSecret,
      data.accessToken,
      data.refreshToken,
      data.accessTokenExpiresAt,
      data.refreshTokenExpiresAt
    );
  }
}

export class ApiCredentialsUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiCredentialsUsageError';
  }
}
