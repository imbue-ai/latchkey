/**
 * Optional `x-latchkey-gateway-permissions-override` header support.
 *
 * The header carries a minimal HS256 JWT whose only payload field is
 * `permissionsConfig`, an absolute path to a `permissions.json` file.
 * When the gateway receives such a header on a `/gateway/...` request and
 * the JWT is valid, it uses the referenced permissions config instead of
 * the default one for that single request.
 *
 * The signing key is derived from the Latchkey encryption key via HKDF-like
 * HMAC-SHA256 with a domain-separation label, so the encryption key itself
 * is never used to sign or verify these JWTs directly.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/**
 * HTTP header used to carry the permissions-override JWT. Lowercased to match
 * how Node's `http.IncomingMessage.headers` exposes header names.
 */
export const PERMISSIONS_OVERRIDE_HEADER = 'x-latchkey-gateway-permissions-override';

/**
 * Domain-separation label mixed into the HMAC that derives the JWT signing
 * key from the Latchkey encryption key. Changing this value invalidates all
 * previously issued tokens.
 */
const SIGNING_KEY_DERIVATION_LABEL = 'latchkey:gateway:permissions-override:v1';

const JWT_HEADER = { alg: 'HS256', typ: 'JWT' } as const;
const JWT_HEADER_ENCODED = Buffer.from(JSON.stringify(JWT_HEADER), 'utf-8').toString('base64url');

export class InvalidPermissionsOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPermissionsOverrideError';
  }
}

export class PermissionsOverrideFileMissingError extends Error {
  constructor(filePath: string) {
    super(`Permissions override references missing or invalid file: ${filePath}`);
    this.name = 'PermissionsOverrideFileMissingError';
  }
}

/**
 * Derive the HS256 signing key used for permissions-override JWTs from the
 * Latchkey encryption key. The encryption key is base64-encoded; the
 * derived key is the raw HMAC-SHA256 output (32 bytes).
 */
export function derivePermissionsOverrideSigningKey(encryptionKeyBase64: string): Buffer {
  const masterKey = Buffer.from(encryptionKeyBase64, 'base64');
  return createHmac('sha256', masterKey).update(SIGNING_KEY_DERIVATION_LABEL).digest();
}

/**
 * Build a permissions-override JWT for the given absolute path. The path is
 * not validated here; callers that want to ensure the file exists must do
 * so before calling this function.
 */
export function createPermissionsOverrideJwt(
  permissionsConfigPath: string,
  signingKey: Buffer
): string {
  if (!isAbsolute(permissionsConfigPath)) {
    throw new InvalidPermissionsOverrideError(
      `permissionsConfig path must be absolute: ${permissionsConfigPath}`
    );
  }
  const payload = { permissionsConfig: permissionsConfigPath };
  const payloadEncoded = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  const signingInput = `${JWT_HEADER_ENCODED}.${payloadEncoded}`;
  const signature = createHmac('sha256', signingKey).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

interface PermissionsOverridePayload {
  readonly permissionsConfig: string;
}

function parsePayload(payloadEncoded: string): PermissionsOverridePayload {
  let payloadJson: string;
  try {
    payloadJson = Buffer.from(payloadEncoded, 'base64url').toString('utf-8');
  } catch {
    throw new InvalidPermissionsOverrideError(
      'Permissions override payload is not valid base64url.'
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    throw new InvalidPermissionsOverrideError('Permissions override payload is not valid JSON.');
  }

  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('permissionsConfig' in payload) ||
    typeof (payload as Record<string, unknown>).permissionsConfig !== 'string'
  ) {
    throw new InvalidPermissionsOverrideError(
      "Permissions override payload must contain a string 'permissionsConfig' field."
    );
  }

  const permissionsConfig = (payload as { permissionsConfig: string }).permissionsConfig;
  if (!isAbsolute(permissionsConfig)) {
    throw new InvalidPermissionsOverrideError(
      `Permissions override 'permissionsConfig' must be an absolute path: ${permissionsConfig}`
    );
  }

  return { permissionsConfig };
}

/**
 * Verify a permissions-override JWT and return its payload. Throws
 * `InvalidPermissionsOverrideError` on any structural, signature, or content
 * issue (i.e. anything that should be reported as "the JWT is invalid").
 *
 * This intentionally does not check that the referenced file exists; that
 * concern is handled by `resolvePermissionsOverride` so that file-system
 * errors can be reported separately from JWT errors.
 */
export function verifyPermissionsOverrideJwt(
  token: string,
  signingKey: Buffer
): PermissionsOverridePayload {
  const segments = token.split('.');
  if (segments.length !== 3) {
    throw new InvalidPermissionsOverrideError(
      'Permissions override JWT must have three dot-separated segments.'
    );
  }
  const headerEncoded = segments[0]!;
  const payloadEncoded = segments[1]!;
  const signatureEncoded = segments[2]!;

  let headerJson: string;
  try {
    headerJson = Buffer.from(headerEncoded, 'base64url').toString('utf-8');
  } catch {
    throw new InvalidPermissionsOverrideError(
      'Permissions override header is not valid base64url.'
    );
  }
  let header: unknown;
  try {
    header = JSON.parse(headerJson);
  } catch {
    throw new InvalidPermissionsOverrideError('Permissions override header is not valid JSON.');
  }
  if (
    typeof header !== 'object' ||
    header === null ||
    (header as Record<string, unknown>).alg !== 'HS256' ||
    (header as Record<string, unknown>).typ !== 'JWT'
  ) {
    throw new InvalidPermissionsOverrideError(
      "Permissions override header must declare alg='HS256' and typ='JWT'."
    );
  }

  let providedSignature: Buffer;
  try {
    providedSignature = Buffer.from(signatureEncoded, 'base64url');
  } catch {
    throw new InvalidPermissionsOverrideError(
      'Permissions override signature is not valid base64url.'
    );
  }

  const expectedSignature = createHmac('sha256', signingKey)
    .update(`${headerEncoded}.${payloadEncoded}`)
    .digest();

  if (
    providedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(providedSignature, expectedSignature)
  ) {
    throw new InvalidPermissionsOverrideError('Permissions override signature is invalid.');
  }

  return parsePayload(payloadEncoded);
}

/**
 * Verify a permissions-override JWT and additionally require the referenced
 * file to exist as a regular file. Returns the absolute path on success.
 */
export function resolvePermissionsOverride(token: string, signingKey: Buffer): string {
  const { permissionsConfig } = verifyPermissionsOverrideJwt(token, signingKey);
  if (!existsSync(permissionsConfig) || !statSync(permissionsConfig).isFile()) {
    throw new PermissionsOverrideFileMissingError(permissionsConfig);
  }
  return permissionsConfig;
}
