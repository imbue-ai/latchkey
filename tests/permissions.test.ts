import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkPermission, PermissionCheckError } from '../src/permissions.js';

describe('checkPermission', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'latchkey-permissions-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should allow requests when no config file exists', async () => {
    const configPath = join(tempDir, 'nonexistent', 'permissions.json');

    const result = await checkPermission(
      ['-X', 'GET', 'https://api.example.com/anything'],
      configPath,
    );

    expect(result).toBe(true);
  });

  it('should allow requests matching a permission rule', async () => {
    const configPath = join(tempDir, 'permissions.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        patterns: {
          'example-api': {
            properties: {
              domain: { const: 'api.example.com' },
            },
            required: ['domain'],
          },
          'example-read': {
            properties: {
              method: { const: 'GET' },
            },
            required: ['method'],
          },
        },
        rules: [{ 'example-api': ['example-read'] }],
      }),
    );

    const result = await checkPermission(
      ['https://api.example.com/users'],
      configPath,
    );

    expect(result).toBe(true);
  });

  it('should deny requests not matching any permission rule', async () => {
    const configPath = join(tempDir, 'permissions.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        patterns: {
          'example-api': {
            properties: {
              domain: { const: 'api.example.com' },
            },
            required: ['domain'],
          },
          'example-read': {
            properties: {
              method: { const: 'GET' },
            },
            required: ['method'],
          },
        },
        rules: [{ 'example-api': ['example-read'] }],
      }),
    );

    const result = await checkPermission(
      ['-X', 'POST', 'https://api.example.com/users'],
      configPath,
    );

    expect(result).toBe(false);
  });

  it('should deny requests to unrecognized domains when rules exist', async () => {
    const configPath = join(tempDir, 'permissions.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        patterns: {
          'example-api': {
            properties: {
              domain: { const: 'api.example.com' },
            },
            required: ['domain'],
          },
          'example-read': {
            properties: {
              method: { const: 'GET' },
            },
            required: ['method'],
          },
        },
        rules: [{ 'example-api': ['example-read'] }],
      }),
    );

    const result = await checkPermission(
      ['https://api.other.com/something'],
      configPath,
    );

    expect(result).toBe(false);
  });

  it('should throw PermissionCheckError for invalid config files', async () => {
    const configPath = join(tempDir, 'permissions.json');
    writeFileSync(configPath, 'not valid json');

    await expect(
      checkPermission(['https://api.example.com/anything'], configPath),
    ).rejects.toThrow(PermissionCheckError);
  });

  it('should allow all requests with the any/any rule', async () => {
    const configPath = join(tempDir, 'permissions.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: [{ any: ['any'] }],
      }),
    );

    const resultGet = await checkPermission(
      ['https://api.example.com/anything'],
      configPath,
    );
    const resultPost = await checkPermission(
      ['-X', 'POST', '-d', '{"key":"value"}', 'https://api.other.com/resource'],
      configPath,
    );

    expect(resultGet).toBe(true);
    expect(resultPost).toBe(true);
  });

  it('should deny all requests when config has empty rules', async () => {
    const configPath = join(tempDir, 'permissions.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: [],
      }),
    );

    const result = await checkPermission(
      ['https://api.example.com/anything'],
      configPath,
    );

    expect(result).toBe(false);
  });
});
