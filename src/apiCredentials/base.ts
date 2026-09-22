/**
 * Base API credentials types and generic credential implementations.
 */

import { z } from 'zod';

export enum ApiCredentialStatus {
  Missing = 'missing',
  Valid = 'valid',
  Invalid = 'invalid',
  Unknown = 'unknown',
}

/**
 * The stored form of credentials: plain JSON whose `objectType` names the
 * {@link ApiCredentialsType} that can read it back.
 */
export interface SerializedApiCredentials {
  readonly objectType: string;
}

/**
 * Base interface for all API credentials.
 * Each credential type must specify how to inject itself into a curl call.
 */
export interface ApiCredentials {
  readonly objectType: string;
  /**
   * The form the credentials are stored in. Left out by credentials that are
   * only ever built on the fly from stored ones and never stored themselves.
   */
  toJSON?(): SerializedApiCredentials;
  /**
   * Inject credentials into a curl call by modifying the given arguments array.
   * Implementations may add headers, change the URL, or transform arguments in any way.
   *
   * `requestBody` carries the actual payload when the caller passes it to curl
   * out-of-band (the gateway streams it via `--data-binary @-` on stdin, so the
   * curl arguments only contain the `@-` placeholder). Credential types whose
   * signature depends on the payload — AWS SigV4 — need the real bytes; all
   * other types ignore it.
   */
  injectIntoCurlCall(
    curlArguments: readonly string[],
    requestBody?: Buffer | null
  ): Promise<readonly string[]>;
  /**
   * Check if the credentials are expired.
   * Returns true if expired, false if valid, or undefined if expiration is unknown.
   */
  isExpired(): boolean | undefined;
}

/**
 * How stored credentials of one `objectType` are read back. This is the static
 * side of a credentials class: `fromJSON` validates the stored JSON and builds
 * the credentials from it, throwing on data it does not accept. Every
 * credentials class latchkey ships with is one, and a plugin that defines its
 * own class lists it in its manifest so that its credentials can be stored.
 */
export interface ApiCredentialsType {
  readonly objectType: string;
  fromJSON(data: unknown): ApiCredentials;
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
  static readonly objectType = 'authorizationBearer' as const;
  readonly objectType = AuthorizationBearer.objectType;
  readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  injectIntoCurlCall(curlArguments: readonly string[]): Promise<readonly string[]> {
    return Promise.resolve(['-H', `Authorization: Bearer ${this.token}`, ...curlArguments]);
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

  static fromJSON(data: unknown): AuthorizationBearer {
    const parsed = AuthorizationBearerSchema.parse(data);
    return new AuthorizationBearer(parsed.token);
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
  static readonly objectType = 'authorizationBare' as const;
  readonly objectType = AuthorizationBare.objectType;
  readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  injectIntoCurlCall(curlArguments: readonly string[]): Promise<readonly string[]> {
    return Promise.resolve(['-H', `Authorization: ${this.token}`, ...curlArguments]);
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

  static fromJSON(data: unknown): AuthorizationBare {
    const parsed = AuthorizationBareSchema.parse(data);
    return new AuthorizationBare(parsed.token);
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
  static readonly objectType = 'rawCurl' as const;
  readonly objectType = RawCurlCredentials.objectType;
  readonly curlArguments: readonly string[];

  constructor(curlArguments: readonly string[]) {
    this.curlArguments = curlArguments;
  }

  injectIntoCurlCall(curlArguments: readonly string[]): Promise<readonly string[]> {
    return Promise.resolve([...this.curlArguments, ...curlArguments]);
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

  static fromJSON(data: unknown): RawCurlCredentials {
    const parsed = RawCurlCredentialsSchema.parse(data);
    return new RawCurlCredentials(parsed.curlArguments);
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
  redirectUri: z.string().optional(),
});

export type OAuthCredentialsData = z.infer<typeof OAuthCredentialsSchema>;

export class OAuthCredentials implements ApiCredentials {
  static readonly objectType = 'oauth' as const;
  readonly objectType = OAuthCredentials.objectType;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly accessTokenExpiresAt?: string;
  readonly refreshTokenExpiresAt?: string;
  /**
   * Where the authorization server sends the user back to, when the OAuth
   * client only permits a pre-registered redirect URI. Left unset in the usual
   * case, where login stands up its own loopback server and uses
   * `http://localhost:<port>/oauth2callback`.
   *
   * An application that embeds latchkey sets this via `latchkey auth prepare`,
   * pointing at a page of its own. That page has to forward the query string
   * the authorization server appended (`code` and friends) to latchkey's
   * loopback callback; the port is not fixed, so services that support an
   * override pass it in the `state` parameter for the page to read back.
   */
  readonly redirectUri?: string;

  // `redirectUri` trails the token fields, out of its natural place next to
  // the client id and secret, so that existing positional callers — including
  // plugins built against an earlier version — keep working.
  constructor(
    clientId: string,
    clientSecret: string,
    accessToken?: string,
    refreshToken?: string,
    accessTokenExpiresAt?: string,
    refreshTokenExpiresAt?: string,
    redirectUri?: string
  ) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.accessTokenExpiresAt = accessTokenExpiresAt;
    this.refreshTokenExpiresAt = refreshTokenExpiresAt;
    this.redirectUri = redirectUri;
  }

  /**
   * The token-less form a preparation is stored in: the OAuth client the next
   * login should use, optionally with the redirect URI it is registered with.
   */
  static prepared(clientId: string, clientSecret: string, redirectUri?: string): OAuthCredentials {
    return new OAuthCredentials(
      clientId,
      clientSecret,
      undefined,
      undefined,
      undefined,
      undefined,
      redirectUri
    );
  }

  injectIntoCurlCall(curlArguments: readonly string[]): Promise<readonly string[]> {
    if (this.accessToken === undefined) {
      throw new ApiCredentialsUsageError(
        'OAuth credentials missing access token. Run login to obtain access tokens.'
      );
    }
    return Promise.resolve(['-H', `Authorization: Bearer ${this.accessToken}`, ...curlArguments]);
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
      redirectUri: this.redirectUri,
    };
    return result;
  }

  static fromJSON(data: unknown): OAuthCredentials {
    const parsed = OAuthCredentialsSchema.parse(data);
    return new OAuthCredentials(
      parsed.clientId,
      parsed.clientSecret,
      parsed.accessToken,
      parsed.refreshToken,
      parsed.accessTokenExpiresAt,
      parsed.refreshTokenExpiresAt,
      parsed.redirectUri
    );
  }
}

export class ApiCredentialsUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiCredentialsUsageError';
  }
}
