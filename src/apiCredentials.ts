/**
 * Serialized API credentials types and utilities.
 *
 */

import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import {
  extractBodyFromCurlArguments,
  extractHeadersFromCurlArguments,
  extractMethodFromCurlArguments,
  extractUrlFromCurlArguments,
} from './curl.js';

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

  injectIntoCurlCall(curlArguments: readonly string[]): readonly string[] {
    return [
      '-H',
      `Authorization: Bearer ${this.token}`,
      '-H',
      `Cookie: d=${this.dCookie}`,
      ...curlArguments,
    ];
  }

  isExpired(): boolean | undefined {
    return undefined;
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
 * Telegram Bot API credentials.
 * The bot token is embedded in the URL path as specified by the Telegram Bot API:
 * https://api.telegram.org/bot<token>/METHOD_NAME
 */
export const TelegramBotCredentialsSchema = z.object({
  objectType: z.literal('telegramBot'),
  token: z.string(),
});

export type TelegramBotCredentialsData = z.infer<typeof TelegramBotCredentialsSchema>;

export class TelegramBotCredentials implements ApiCredentials {
  readonly objectType = 'telegramBot' as const;
  readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  injectIntoCurlCall(curlArguments: readonly string[]): readonly string[] {
    const url = extractUrlFromCurlArguments(curlArguments as string[]);
    if (!url?.startsWith('https://api.telegram.org/')) {
      return curlArguments;
    }
    const pathAfterBase = url.slice('https://api.telegram.org/'.length);
    const rewrittenUrl = `https://api.telegram.org/bot${this.token}/${pathAfterBase}`;
    return curlArguments.map((argument) => (argument === url ? rewrittenUrl : argument));
  }

  isExpired(): boolean | undefined {
    return undefined;
  }

  toJSON(): TelegramBotCredentialsData {
    return {
      objectType: this.objectType,
      token: this.token,
    };
  }

  static fromJSON(data: TelegramBotCredentialsData): TelegramBotCredentials {
    return new TelegramBotCredentials(data.token);
  }
}

/**
 * AWS credentials using Signature Version 4 request signing.
 * Stores an access key ID and secret access key, and signs each request
 * by computing the Authorization, x-amz-date, and x-amz-content-sha256 headers.
 */
export const AwsCredentialsSchema = z.object({
  objectType: z.literal('aws'),
  accessKeyId: z.string(),
  secretAccessKey: z.string(),
});

export type AwsCredentialsData = z.infer<typeof AwsCredentialsSchema>;

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf-8').digest('hex');
}

function hmacSha256(key: Buffer, message: string): Buffer {
  return createHmac('sha256', key).update(message, 'utf-8').digest();
}

function hmacSha256Hex(key: Buffer, message: string): string {
  return createHmac('sha256', key).update(message, 'utf-8').digest('hex');
}

/** URI-encode per RFC 3986: unreserved chars A-Za-z0-9 - _ . ~ are left as-is. */
function awsUriEncode(value: string, encodeSlash: boolean): string {
  const result: string[] = [];
  for (const character of value) {
    if (
      (character >= 'A' && character <= 'Z') ||
      (character >= 'a' && character <= 'z') ||
      (character >= '0' && character <= '9') ||
      character === '-' ||
      character === '_' ||
      character === '.' ||
      character === '~'
    ) {
      result.push(character);
    } else if (character === '/' && !encodeSlash) {
      result.push('/');
    } else {
      for (const byte of Buffer.from(character, 'utf-8')) {
        result.push('%' + byte.toString(16).toUpperCase().padStart(2, '0'));
      }
    }
  }
  return result.join('');
}

function deriveSigningKey(
  secretAccessKey: string,
  datestamp: string,
  region: string,
  service: string
): Buffer {
  const kDate = hmacSha256(Buffer.from('AWS4' + secretAccessKey, 'utf-8'), datestamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

/**
 * Detect the AWS region and service from a hostname like "sts.us-east-1.amazonaws.com"
 * or "s3.amazonaws.com" or "bedrock-runtime.us-west-2.amazonaws.com".
 */
function parseAwsHostname(hostname: string): { region: string; service: string } {
  // Strip ".amazonaws.com" suffix
  const suffix = '.amazonaws.com';
  if (!hostname.endsWith(suffix)) {
    return { region: 'us-east-1', service: 'execute-api' };
  }
  const prefix = hostname.slice(0, -suffix.length);

  // Patterns: "service.region", "service", "region.service" (for S3)
  const parts = prefix.split('.');

  if (parts.length === 1) {
    // e.g., "sts" → global service, default region
    return { region: 'us-east-1', service: parts[0]! };
  }

  if (parts.length === 2) {
    // e.g., "sts.us-east-1" or "s3.us-west-2"
    // Heuristic: if second part looks like a region (contains a dash and digit)
    if (/^[a-z]{2}(-[a-z]+-\d+)?$/.test(parts[1]!)) {
      return { region: parts[1]!, service: parts[0]! };
    }
    // e.g., "us-east-1.s3" (S3 path-style)
    if (/^[a-z]{2}(-[a-z]+-\d+)?$/.test(parts[0]!)) {
      return { region: parts[0]!, service: parts[1]! };
    }
    // Fallback: first is service, second is region
    return { region: parts[1]!, service: parts[0]! };
  }

  // 3+ parts: e.g., "bedrock-runtime.us-west-2" split further
  // Try to find the region-like part
  for (let i = 1; i < parts.length; i++) {
    if (/^[a-z]{2}-[a-z]+-\d+$/.test(parts[i]!)) {
      return { region: parts[i]!, service: parts.slice(0, i).join('.') };
    }
  }

  return { region: 'us-east-1', service: parts[0]! };
}

function signAwsRequest(
  method: string,
  url: URL,
  existingHeaders: Record<string, string>,
  body: string,
  accessKeyId: string,
  secretAccessKey: string
): readonly string[] {
  const { region, service } = parseAwsHostname(url.hostname);
  const now = new Date();
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const datestamp = amzDate.slice(0, 8);

  const payloadHash = sha256Hex(body);

  // Build headers to sign
  const headersToSign: Record<string, string> = {
    host: url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  };

  // Include content-type if present
  if (existingHeaders['content-type'] !== undefined) {
    headersToSign['content-type'] = existingHeaders['content-type'];
  }

  const signedHeaderNames = Object.keys(headersToSign).sort();
  const signedHeadersString = signedHeaderNames.join(';');

  // Step 1: Canonical request
  const canonicalUri = awsUriEncode(decodeURIComponent(url.pathname || '/'), false);

  const queryParameters: [string, string][] = [];
  url.searchParams.forEach((value, key) => {
    queryParameters.push([awsUriEncode(key, true), awsUriEncode(value, true)]);
  });
  queryParameters.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  const canonicalQueryString = queryParameters.map(([k, v]) => `${k}=${v}`).join('&');

  const canonicalHeaders =
    signedHeaderNames.map((name) => `${name}:${headersToSign[name]!.trim()}`).join('\n') + '\n';

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeadersString,
    payloadHash,
  ].join('\n');

  // Step 2: String to sign
  const credentialScope = `${datestamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  // Step 3: Signature
  const signingKey = deriveSigningKey(secretAccessKey, datestamp, region, service);
  const signature = hmacSha256Hex(signingKey, stringToSign);

  // Step 4: Authorization header
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeadersString}, ` +
    `Signature=${signature}`;

  return [
    '-H',
    `Authorization: ${authorization}`,
    '-H',
    `x-amz-date: ${amzDate}`,
    '-H',
    `x-amz-content-sha256: ${payloadHash}`,
  ];
}

export class AwsCredentials implements ApiCredentials {
  readonly objectType = 'aws' as const;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;

  constructor(accessKeyId: string, secretAccessKey: string) {
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
  }

  injectIntoCurlCall(curlArguments: readonly string[]): readonly string[] {
    const url = extractUrlFromCurlArguments(curlArguments as string[]);
    if (url === null) {
      return curlArguments;
    }

    const method = extractMethodFromCurlArguments(curlArguments);
    const body = extractBodyFromCurlArguments(curlArguments);
    const existingHeaders = extractHeadersFromCurlArguments(curlArguments);
    const parsedUrl = new URL(url);

    const signingHeaders = signAwsRequest(
      method,
      parsedUrl,
      existingHeaders,
      body,
      this.accessKeyId,
      this.secretAccessKey
    );

    return [...signingHeaders, ...curlArguments];
  }

  isExpired(): boolean | undefined {
    return undefined;
  }

  toJSON(): AwsCredentialsData {
    return {
      objectType: this.objectType,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
    };
  }

  static fromJSON(data: AwsCredentialsData): AwsCredentials {
    return new AwsCredentials(data.accessKeyId, data.secretAccessKey);
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
