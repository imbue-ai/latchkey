import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import { ApiCredentialStatus, type ApiCredentials } from '../apiCredentials.js';
import {
  extractBodyFromCurlArguments,
  extractHeadersFromCurlArguments,
  extractMethodFromCurlArguments,
  extractUrlFromCurlArguments,
  runCaptured,
} from '../curl.js';
import { NoCurlCredentialsNotSupportedError, Service } from './base.js';

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

export class Aws extends Service {
  readonly name = 'aws';
  readonly displayName = 'AWS';
  readonly baseApiUrls = [/^https:\/\/[^/]*\.amazonaws\.com\//] as const;
  readonly loginUrl = 'https://console.aws.amazon.com/';
  readonly info = 'https://docs.aws.amazon.com/.';

  readonly credentialCheckCurlArguments = [
    'https://sts.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15',
  ] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set-nocurl ${serviceName} AKIAIOSFODNN7EXAMPLE wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY`;
  }

  override getCredentialsNoCurl(arguments_: readonly string[]): ApiCredentials {
    if (arguments_.length !== 2 || arguments_[0] === undefined || arguments_[1] === undefined) {
      throw new AwsCredentialError(
        'Expected exactly two arguments: <access-key-id> <secret-access-key>.\n' +
          'Example: latchkey auth set-nocurl aws AKIAIOSFODNN7EXAMPLE wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
      );
    }
    const accessKeyId = arguments_[0];
    const secretAccessKey = arguments_[1];
    if (!accessKeyId.startsWith('AKIA') && !accessKeyId.startsWith('ASIA')) {
      throw new AwsCredentialError(
        "The provided access key ID doesn't look like an AWS access key ID " +
          '(expected to start with AKIA or ASIA).\n' +
          'Example: AKIAIOSFODNN7EXAMPLE'
      );
    }
    return new AwsCredentials(accessKeyId, secretAccessKey);
  }

  override checkApiCredentials(apiCredentials: ApiCredentials): ApiCredentialStatus {
    const allCurlArgs = apiCredentials.injectIntoCurlCall([
      '-s',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      ...this.credentialCheckCurlArguments,
    ]);

    const result = runCaptured(allCurlArgs, 10);

    if (result.stdout === '200') {
      return ApiCredentialStatus.Valid;
    }
    return ApiCredentialStatus.Invalid;
  }
}

class AwsCredentialError extends NoCurlCredentialsNotSupportedError {
  constructor(message: string) {
    super('aws');
    this.message = message;
    this.name = 'AwsCredentialError';
  }
}

export const AWS = new Aws();
