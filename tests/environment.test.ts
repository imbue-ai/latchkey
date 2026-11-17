import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Config } from '../src/config.js';
import {
  InvalidEnvironmentOverridesError,
  loadEnvironmentOverrides,
  parseEnvironmentOverrides,
} from '../src/environment.js';

describe('parseEnvironmentOverrides', () => {
  it('accepts known variable names with string values', () => {
    expect(
      parseEnvironmentOverrides(
        '{"LATCHKEY_ENCRYPTION_KEY": "secret", "LATCHKEY_GATEWAY_LISTEN_PORT": "2000"}'
      )
    ).toEqual({ LATCHKEY_ENCRYPTION_KEY: 'secret', LATCHKEY_GATEWAY_LISTEN_PORT: '2000' });
  });

  it.each([
    ['malformed JSON', '{'],
    ['a non-object document', '["LATCHKEY_CURL"]'],
    ['a non-string value', '{"LATCHKEY_GATEWAY_LISTEN_PORT": 2000}'],
    ['an unknown variable name', '{"LATCHKEY_ENCRYPTION_KEI": "secret"}'],
    ['the descriptor variable itself', '{"LATCHKEY_ENV_OVERRIDES_FD": "4"}'],
  ])('rejects %s', (_description, content) => {
    expect(() => parseEnvironmentOverrides(content)).toThrow(InvalidEnvironmentOverridesError);
  });
});

describe('loadEnvironmentOverrides', () => {
  it('returns no overrides when the descriptor is unset or empty', () => {
    const failingReader = (): string => {
      throw new InvalidEnvironmentOverridesError('should not be read');
    };
    expect(loadEnvironmentOverrides(undefined, failingReader)).toEqual({});
    expect(loadEnvironmentOverrides('', failingReader)).toEqual({});
  });

  it('reads the overrides from the given descriptor', () => {
    const overrides = loadEnvironmentOverrides('7', (fileDescriptor) => {
      expect(fileDescriptor).toBe(7);
      return '{"LATCHKEY_CURL": "/opt/curl"}';
    });
    expect(overrides).toEqual({ LATCHKEY_CURL: '/opt/curl' });
  });

  it('rejects a value that is not a descriptor number', () => {
    expect(() => loadEnvironmentOverrides('three', () => '{}')).toThrow(
      InvalidEnvironmentOverridesError
    );
  });

  it('rejects a descriptor that cannot be read', () => {
    expect(() => loadEnvironmentOverrides('987654')).toThrow(InvalidEnvironmentOverridesError);
  });
});

describe('Config with environment overrides', () => {
  it('prefers overrides over the process environment', () => {
    const overrides = parseEnvironmentOverrides(
      '{"LATCHKEY_ENCRYPTION_KEY": "from-descriptor", "LATCHKEY_DISABLE_BROWSER": "1"}'
    );
    const environment: Record<string, string> = {
      LATCHKEY_ENCRYPTION_KEY: 'from-environment',
      LATCHKEY_CURL: '/opt/curl',
    };
    const config = new Config(
      (name) => overrides[name] ?? environment[name],
      () => ({})
    );
    expect(config.encryptionKeyOverride).toBe('from-descriptor');
    expect(config.browserDisabled).toBe(true);
    expect(config.curlCommand).toBe('/opt/curl');
  });
});

describe.skipIf(process.platform === 'win32')('LATCHKEY_ENV_OVERRIDES_FD end to end', () => {
  it('reads overrides from an inherited descriptor and hides it from children', () => {
    const directory = mkdtempSync(join(tmpdir(), 'latchkey-environment-'));
    try {
      const overridesPath = join(directory, 'overrides.json');
      writeFileSync(
        overridesPath,
        JSON.stringify({ LATCHKEY_ENCRYPTION_KEY: 'from-descriptor', LATCHKEY_CURL: '/opt/curl' })
      );
      const script = [
        "const { CONFIG } = await import('./src/config.ts');",
        'console.log(JSON.stringify({',
        '  encryptionKey: CONFIG.encryptionKeyOverride,',
        '  curlCommand: CONFIG.curlCommand,',
        '  descriptorVariable: process.env.LATCHKEY_ENV_OVERRIDES_FD ?? null,',
        '}));',
      ].join('\n');
      const output = execFileSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', script],
        {
          cwd: resolve(import.meta.dirname, '..'),
          env: {
            ...process.env,
            LATCHKEY_DIRECTORY: directory,
            LATCHKEY_ENCRYPTION_KEY: 'from-environment',
            LATCHKEY_ENV_OVERRIDES_FD: '3',
          },
          stdio: ['ignore', 'pipe', 'inherit', openSync(overridesPath, 'r')],
          encoding: 'utf-8',
        }
      );
      expect(JSON.parse(output)).toEqual({
        encryptionKey: 'from-descriptor',
        curlCommand: '/opt/curl',
        descriptorVariable: null,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
