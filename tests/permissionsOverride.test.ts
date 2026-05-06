import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createPermissionsOverrideJwt,
  derivePermissionsOverrideSigningKey,
  InvalidPermissionsOverrideError,
  PERMISSIONS_OVERRIDE_HEADER,
  PermissionsOverrideFileMissingError,
  resolvePermissionsOverride,
  verifyPermissionsOverrideJwt,
} from '../src/gateway/permissionsOverride.js';

const TEST_ENCRYPTION_KEY = 'dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleXRlc3Q=';
const OTHER_ENCRYPTION_KEY = 'b3RoZXJrZXlvdGhlcmtleW90aGVya2V5b3RoZXJrZXk=';

describe('PERMISSIONS_OVERRIDE_HEADER', () => {
  it('is the lowercase header name', () => {
    expect(PERMISSIONS_OVERRIDE_HEADER).toBe('x-latchkey-gateway-permissions-override');
  });
});

describe('derivePermissionsOverrideSigningKey', () => {
  it('produces a deterministic 32-byte key', () => {
    const a = derivePermissionsOverrideSigningKey(TEST_ENCRYPTION_KEY);
    const b = derivePermissionsOverrideSigningKey(TEST_ENCRYPTION_KEY);
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(true);
  });

  it('produces different keys for different master keys', () => {
    const a = derivePermissionsOverrideSigningKey(TEST_ENCRYPTION_KEY);
    const b = derivePermissionsOverrideSigningKey(OTHER_ENCRYPTION_KEY);
    expect(a.equals(b)).toBe(false);
  });

  it('does not equal the encryption key itself', () => {
    const derived = derivePermissionsOverrideSigningKey(TEST_ENCRYPTION_KEY);
    const master = Buffer.from(TEST_ENCRYPTION_KEY, 'base64');
    expect(derived.equals(master)).toBe(false);
  });
});

describe('createPermissionsOverrideJwt / verifyPermissionsOverrideJwt', () => {
  const signingKey = derivePermissionsOverrideSigningKey(TEST_ENCRYPTION_KEY);

  it('round-trips an absolute path', () => {
    const token = createPermissionsOverrideJwt('/etc/latchkey/permissions.json', signingKey);
    const payload = verifyPermissionsOverrideJwt(token, signingKey);
    expect(payload).toEqual({ permissionsConfig: '/etc/latchkey/permissions.json' });
  });

  it('produces a three-segment JWT', () => {
    const token = createPermissionsOverrideJwt('/x.json', signingKey);
    expect(token.split('.')).toHaveLength(3);
  });

  it('uses HS256/JWT in the header', () => {
    const token = createPermissionsOverrideJwt('/x.json', signingKey);
    const header = token.split('.')[0]!;
    const json = Buffer.from(header, 'base64url').toString('utf-8');
    expect(JSON.parse(json)).toEqual({ alg: 'HS256', typ: 'JWT' });
  });

  it('payload contains only the permissionsConfig field', () => {
    const token = createPermissionsOverrideJwt('/x.json', signingKey);
    const payload = token.split('.')[1]!;
    const json = Buffer.from(payload, 'base64url').toString('utf-8');
    expect(JSON.parse(json)).toEqual({ permissionsConfig: '/x.json' });
  });

  it('rejects creation for non-absolute paths', () => {
    expect(() => createPermissionsOverrideJwt('relative/path.json', signingKey)).toThrow(
      InvalidPermissionsOverrideError
    );
  });

  it('rejects tokens signed with a different key', () => {
    const otherKey = derivePermissionsOverrideSigningKey(OTHER_ENCRYPTION_KEY);
    const token = createPermissionsOverrideJwt('/x.json', otherKey);
    expect(() => verifyPermissionsOverrideJwt(token, signingKey)).toThrow(
      InvalidPermissionsOverrideError
    );
  });

  it('rejects tokens with a tampered payload', () => {
    const token = createPermissionsOverrideJwt('/x.json', signingKey);
    const [header, , signature] = token.split('.') as [string, string, string];
    const tamperedPayload = Buffer.from(
      JSON.stringify({ permissionsConfig: '/y.json' }),
      'utf-8'
    ).toString('base64url');
    const tampered = `${header}.${tamperedPayload}.${signature}`;
    expect(() => verifyPermissionsOverrideJwt(tampered, signingKey)).toThrow(
      InvalidPermissionsOverrideError
    );
  });

  it('rejects tokens that do not have three segments', () => {
    expect(() => verifyPermissionsOverrideJwt('a.b', signingKey)).toThrow(
      InvalidPermissionsOverrideError
    );
    expect(() => verifyPermissionsOverrideJwt('a.b.c.d', signingKey)).toThrow(
      InvalidPermissionsOverrideError
    );
  });

  function base64Url(value: string): string {
    return Buffer.from(value, 'utf-8').toString('base64url');
  }

  function buildSignedToken(headerJson: string, payloadJson: string): string {
    const headerSegment = base64Url(headerJson);
    const payloadSegment = base64Url(payloadJson);
    const signature = createHmac('sha256', signingKey)
      .update(`${headerSegment}.${payloadSegment}`)
      .digest('base64url');
    return `${headerSegment}.${payloadSegment}.${signature}`;
  }

  it('rejects tokens whose payload is not valid JSON', () => {
    // Sign a payload that is base64url of "not-json" so we hit the JSON parse
    // error rather than the signature mismatch error first.
    const headerSegment = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payloadSegment = base64Url('not-json');
    const signature = createHmac('sha256', signingKey)
      .update(`${headerSegment}.${payloadSegment}`)
      .digest('base64url');
    const token = `${headerSegment}.${payloadSegment}.${signature}`;
    expect(() => verifyPermissionsOverrideJwt(token, signingKey)).toThrow(
      InvalidPermissionsOverrideError
    );
  });

  it('rejects payloads without permissionsConfig', () => {
    const token = buildSignedToken(
      JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
      JSON.stringify({ other: '/x.json' })
    );
    expect(() => verifyPermissionsOverrideJwt(token, signingKey)).toThrow(
      InvalidPermissionsOverrideError
    );
  });

  it('rejects payloads whose permissionsConfig is not absolute', () => {
    const token = buildSignedToken(
      JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
      JSON.stringify({ permissionsConfig: 'relative.json' })
    );
    expect(() => verifyPermissionsOverrideJwt(token, signingKey)).toThrow(
      InvalidPermissionsOverrideError
    );
  });

  it('rejects headers with the wrong algorithm', () => {
    const token = buildSignedToken(
      JSON.stringify({ alg: 'none', typ: 'JWT' }),
      JSON.stringify({ permissionsConfig: '/x.json' })
    );
    expect(() => verifyPermissionsOverrideJwt(token, signingKey)).toThrow(
      InvalidPermissionsOverrideError
    );
  });
});

describe('resolvePermissionsOverride', () => {
  const signingKey = derivePermissionsOverrideSigningKey(TEST_ENCRYPTION_KEY);
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'latchkey-pp-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns the path when the file exists', () => {
    const path = join(tempDir, 'permissions.json');
    writeFileSync(path, '{}');
    const token = createPermissionsOverrideJwt(path, signingKey);
    expect(resolvePermissionsOverride(token, signingKey)).toBe(path);
  });

  it('throws PermissionsOverrideFileMissingError when the file is absent', () => {
    const path = join(tempDir, 'does-not-exist.json');
    const token = createPermissionsOverrideJwt(path, signingKey);
    expect(() => resolvePermissionsOverride(token, signingKey)).toThrow(
      PermissionsOverrideFileMissingError
    );
  });

  it('throws PermissionsOverrideFileMissingError when the path is a directory', () => {
    const path = join(tempDir, 'subdir');
    mkdirSync(path);
    const token = createPermissionsOverrideJwt(path, signingKey);
    expect(() => resolvePermissionsOverride(token, signingKey)).toThrow(
      PermissionsOverrideFileMissingError
    );
  });
});
