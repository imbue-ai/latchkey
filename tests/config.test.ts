import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  Config,
  CurlNotFoundError,
  InsecureFilePermissionsError,
  DEFAULT_GATEWAY_LISTEN_HOST,
  DEFAULT_GATEWAY_LISTEN_PORT,
  DEFAULT_KEYRING_ACCOUNT_NAME,
  DEFAULT_KEYRING_SERVICE_NAME,
  InvalidGatewayListenPortError,
} from '../src/config.js';

describe('Config with config.json settings', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'latchkey-config-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function writeSettings(settings: Record<string, unknown>): void {
    writeFileSync(join(directory, 'config.json'), JSON.stringify({ settings }, null, 2));
  }

  function makeConfig(env: Record<string, string | undefined> = {}): Config {
    return new Config((name) => {
      if (name === 'LATCHKEY_DIRECTORY') return directory;
      return env[name];
    });
  }

  it('uses built-in defaults when neither env vars nor settings file define values', () => {
    const config = makeConfig();

    expect(config.curlCommand).toBe('curl');
    expect(config.serviceName).toBe(DEFAULT_KEYRING_SERVICE_NAME);
    expect(config.accountName).toBe(DEFAULT_KEYRING_ACCOUNT_NAME);
    expect(config.browserDisabled).toBe(false);
    expect(config.browserEphemeral).toBe(false);
    expect(config.countingDisabled).toBe(false);
    expect(config.credentialsRefreshDisabled).toBe(false);
    expect(config.permissionsConfigOverride).toBeNull();
    expect(config.permissionsDoNotUseBuiltinSchemas).toBe(false);
    expect(config.passthroughUnknown).toBe(false);
    expect(config.hideBuiltinServices).toEqual([]);
    expect(config.diagnosticHeaders).toBe(false);
    expect(config.gatewayUrl).toBeNull();
    expect(config.gatewayListenHost).toBe(DEFAULT_GATEWAY_LISTEN_HOST);
    expect(config.gatewayListenPort).toBe(DEFAULT_GATEWAY_LISTEN_PORT);
    expect(DEFAULT_GATEWAY_LISTEN_PORT).toBe(1989);
  });

  it('reads settings from config.json when env vars are not set', () => {
    writeSettings({
      curlCommand: '/usr/bin/custom-curl',
      keyringServiceName: 'file-service',
      keyringAccountName: 'file-account',
      browserDisabled: true,
      browserEphemeral: true,
      countingDisabled: true,
      credentialsRefreshDisabled: true,
      permissionsConfig: '/etc/latchkey/perm.json',
      permissionsDoNotUseBuiltinSchemas: true,
      passthroughUnknown: true,
      hideBuiltinServices: ['slack', 'github'],
      gateway: 'http://localhost:9000/',
      gatewayListenHost: '0.0.0.0',
      gatewayListenPort: 4242,
    });

    const config = makeConfig();

    expect(config.curlCommand).toBe('/usr/bin/custom-curl');
    expect(config.serviceName).toBe('file-service');
    expect(config.accountName).toBe('file-account');
    expect(config.browserDisabled).toBe(true);
    expect(config.browserEphemeral).toBe(true);
    expect(config.countingDisabled).toBe(true);
    expect(config.credentialsRefreshDisabled).toBe(true);
    expect(config.permissionsConfigOverride).toBe('/etc/latchkey/perm.json');
    expect(config.permissionsDoNotUseBuiltinSchemas).toBe(true);
    expect(config.passthroughUnknown).toBe(true);
    expect(config.hideBuiltinServices).toEqual(['slack', 'github']);
    expect(config.gatewayUrl).toBe('http://localhost:9000');
    expect(config.gatewayListenHost).toBe('0.0.0.0');
    expect(config.gatewayListenPort).toBe(4242);
  });

  it('ignores invalid gatewayListenPort values and falls back to the default', () => {
    writeSettings({ gatewayListenPort: 'not-a-number', gatewayListenHost: 42 });

    const config = makeConfig();

    expect(config.gatewayListenHost).toBe(DEFAULT_GATEWAY_LISTEN_HOST);
    expect(config.gatewayListenPort).toBe(DEFAULT_GATEWAY_LISTEN_PORT);
  });

  it('env vars take precedence over config.json settings', () => {
    writeSettings({
      curlCommand: '/from/file',
      keyringServiceName: 'file-service',
      keyringAccountName: 'file-account',
      browserDisabled: false,
      countingDisabled: false,
      permissionsConfig: '/file/perm.json',
      permissionsDoNotUseBuiltinSchemas: false,
      passthroughUnknown: false,
      gateway: 'http://file-gateway',
    });

    const config = makeConfig({
      LATCHKEY_CURL: '/from/env',
      LATCHKEY_KEYRING_SERVICE_NAME: 'env-service',
      LATCHKEY_KEYRING_ACCOUNT_NAME: 'env-account',
      LATCHKEY_DISABLE_BROWSER: '1',
      LATCHKEY_EPHEMERAL_BROWSER: '1',
      LATCHKEY_DISABLE_COUNTING: '1',
      LATCHKEY_DISABLE_CREDENTIALS_REFRESH: '1',
      LATCHKEY_PERMISSIONS_CONFIG: '/env/perm.json',
      LATCHKEY_PERMISSIONS_DO_NOT_USE_BUILTIN_SCHEMAS: '1',
      LATCHKEY_PASSTHROUGH_UNKNOWN: '1',
      LATCHKEY_HIDE_BUILTIN_SERVICES: ' slack , github ,, ',
      LATCHKEY_GATEWAY: 'http://env-gateway/',
      LATCHKEY_GATEWAY_LISTEN_HOST: '127.0.0.1',
      LATCHKEY_GATEWAY_LISTEN_PORT: '5555',
    });

    expect(config.curlCommand).toBe('/from/env');
    expect(config.serviceName).toBe('env-service');
    expect(config.accountName).toBe('env-account');
    expect(config.browserDisabled).toBe(true);
    expect(config.browserEphemeral).toBe(true);
    expect(config.countingDisabled).toBe(true);
    expect(config.credentialsRefreshDisabled).toBe(true);
    expect(config.permissionsConfigOverride).toBe('/env/perm.json');
    expect(config.permissionsDoNotUseBuiltinSchemas).toBe(true);
    expect(config.passthroughUnknown).toBe(true);
    expect(config.hideBuiltinServices).toEqual(['slack', 'github']);
    expect(config.gatewayUrl).toBe('http://env-gateway');
    expect(config.gatewayListenHost).toBe('127.0.0.1');
    expect(config.gatewayListenPort).toBe(5555);
  });

  it('throws InvalidGatewayListenPortError for a non-numeric env var', () => {
    expect(() => makeConfig({ LATCHKEY_GATEWAY_LISTEN_PORT: 'abc' })).toThrow(
      InvalidGatewayListenPortError
    );
  });

  it('throws InvalidGatewayListenPortError for an out-of-range env var', () => {
    expect(() => makeConfig({ LATCHKEY_GATEWAY_LISTEN_PORT: '70000' })).toThrow(
      InvalidGatewayListenPortError
    );
  });

  it('turns diagnostic headers on from config.json or from a non-empty env var', () => {
    expect(makeConfig({ LATCHKEY_DIAGNOSTIC_HEADERS: '1' }).diagnosticHeaders).toBe(true);
    expect(makeConfig({ LATCHKEY_DIAGNOSTIC_HEADERS: '' }).diagnosticHeaders).toBe(false);

    writeSettings({ diagnosticHeaders: true });

    expect(makeConfig().diagnosticHeaders).toBe(true);
  });

  it('an empty LATCHKEY_GATEWAY_LISTEN_PORT env var falls through to config.json', () => {
    writeSettings({ gatewayListenPort: 4242 });

    const config = makeConfig({ LATCHKEY_GATEWAY_LISTEN_PORT: '' });

    expect(config.gatewayListenPort).toBe(4242);
  });

  it('an empty env var does not override a config.json boolean flag', () => {
    writeSettings({ browserDisabled: true, countingDisabled: true });

    const config = makeConfig({
      LATCHKEY_DISABLE_BROWSER: '',
      LATCHKEY_DISABLE_COUNTING: '',
    });

    expect(config.browserDisabled).toBe(true);
    expect(config.countingDisabled).toBe(true);
  });

  it('an empty env var does not override a config.json optional string', () => {
    writeSettings({ gateway: 'http://file-gateway', permissionsConfig: '/file/perm.json' });

    const config = makeConfig({
      LATCHKEY_GATEWAY: '',
      LATCHKEY_PERMISSIONS_CONFIG: '',
    });

    expect(config.gatewayUrl).toBe('http://file-gateway');
    expect(config.permissionsConfigOverride).toBe('/file/perm.json');
  });

  it('ignores malformed settings and falls back to defaults', () => {
    writeFileSync(
      join(directory, 'config.json'),
      JSON.stringify({ settings: { curlCommand: 42, browserDisabled: 'yes' } })
    );

    const config = makeConfig();

    expect(config.curlCommand).toBe('curl');
    expect(config.browserDisabled).toBe(false);
  });

  it('reads the client-side gateway password only from the environment', () => {
    writeSettings({});
    const config = makeConfig({ LATCHKEY_GATEWAY_PASSWORD: 'top-secret' });
    expect(config.gatewayPassword).toBe('top-secret');
    expect(config.gatewayListenPassword).toBeNull();
  });

  it('reads the listen-side gateway password only from the environment', () => {
    writeSettings({});
    const config = makeConfig({ LATCHKEY_GATEWAY_LISTEN_PASSWORD: 'listen-secret' });
    expect(config.gatewayListenPassword).toBe('listen-secret');
    expect(config.gatewayPassword).toBeNull();
  });

  it('treats unset or empty gateway password env vars as no password', () => {
    expect(makeConfig().gatewayPassword).toBeNull();
    expect(makeConfig().gatewayListenPassword).toBeNull();
    expect(
      makeConfig({ LATCHKEY_GATEWAY_PASSWORD: '', LATCHKEY_GATEWAY_LISTEN_PASSWORD: '' })
        .gatewayPassword
    ).toBeNull();
    expect(
      makeConfig({ LATCHKEY_GATEWAY_PASSWORD: '', LATCHKEY_GATEWAY_LISTEN_PASSWORD: '' })
        .gatewayListenPassword
    ).toBeNull();
  });

  it('reads the gateway permissions override only from the environment', () => {
    writeSettings({});
    const config = makeConfig({ LATCHKEY_GATEWAY_PERMISSIONS_OVERRIDE: 'jwt.value.here' });
    expect(config.gatewayPermissionsOverride).toBe('jwt.value.here');
  });

  it('treats unset or empty LATCHKEY_GATEWAY_PERMISSIONS_OVERRIDE as no override', () => {
    expect(makeConfig().gatewayPermissionsOverride).toBeNull();
    expect(
      makeConfig({ LATCHKEY_GATEWAY_PERMISSIONS_OVERRIDE: '' }).gatewayPermissionsOverride
    ).toBeNull();
  });

  it('keeps client and listen gateway passwords independent', () => {
    const config = makeConfig({
      LATCHKEY_GATEWAY_PASSWORD: 'client',
      LATCHKEY_GATEWAY_LISTEN_PASSWORD: 'server',
    });
    expect(config.gatewayPassword).toBe('client');
    expect(config.gatewayListenPassword).toBe('server');
  });

  it('ignores an unparseable config.json entirely', () => {
    writeFileSync(join(directory, 'config.json'), 'not json{');

    const config = makeConfig();

    expect(config.curlCommand).toBe('curl');
  });
});

describe('Config system checks across platforms', () => {
  const originalPlatform = process.platform;
  const originalPath = process.env.PATH;
  const originalPathExt = process.env.PATHEXT;
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'latchkey-config-platform-'));
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    process.env.PATH = originalPath;
    if (originalPathExt === undefined) {
      delete process.env.PATHEXT;
    } else {
      process.env.PATHEXT = originalPathExt;
    }
    rmSync(directory, { recursive: true, force: true });
  });

  function pretendPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform });
  }

  function makeConfig(env: Record<string, string | undefined> = {}): Config {
    return new Config((name) => {
      if (name === 'LATCHKEY_DIRECTORY') return directory;
      return env[name];
    });
  }

  // Windows file systems are case-insensitive, so `curl.exe` matches the
  // `.EXE` entry of PATHEXT there. These tests run on POSIX too, where the
  // file name has to match the extension's casing exactly.
  function installFakeCurl(fileName: string): string {
    const binDirectory = join(directory, 'bin');
    mkdirSync(binDirectory, { recursive: true });
    const curlPath = join(binDirectory, fileName);
    writeFileSync(curlPath, '', { mode: 0o755 });
    return curlPath;
  }

  describe('checkSystemPrerequisites', () => {
    it.skipIf(originalPlatform === 'win32')('does not find curl.exe through PATH on POSIX', () => {
      pretendPlatform('linux');
      const curlPath = installFakeCurl('curl.exe');
      process.env.PATH = join(curlPath, '..');
      expect(() => {
        makeConfig().checkSystemPrerequisites();
      }).toThrow(CurlNotFoundError);
    });

    it('finds curl.exe through PATH on Windows using PATHEXT', () => {
      pretendPlatform('win32');
      const curlPath = installFakeCurl('curl.exe');
      process.env.PATH = ['', join(curlPath, '..')].join(delimiter);
      process.env.PATHEXT = '.COM;.exe;.BAT;.CMD';
      expect(() => {
        makeConfig().checkSystemPrerequisites();
      }).not.toThrow();
    });

    it('falls back to the usual executable extensions on Windows when PATHEXT is unset', () => {
      pretendPlatform('win32');
      const curlPath = installFakeCurl('curl.EXE');
      process.env.PATH = join(curlPath, '..');
      delete process.env.PATHEXT;
      expect(() => {
        makeConfig().checkSystemPrerequisites();
      }).not.toThrow();
    });

    it('resolves an absolute LATCHKEY_CURL without an extension on Windows', () => {
      pretendPlatform('win32');
      const curlPath = installFakeCurl('curl.EXE');
      process.env.PATH = '';
      delete process.env.PATHEXT;
      expect(() => {
        makeConfig({ LATCHKEY_CURL: curlPath.slice(0, -'.EXE'.length) }).checkSystemPrerequisites();
      }).not.toThrow();
    });

    it('uses a command that already has an extension as is', () => {
      pretendPlatform('win32');
      installFakeCurl('curl.exe');
      process.env.PATH = join(directory, 'bin');
      expect(() => {
        makeConfig({ LATCHKEY_CURL: 'curl.cmd' }).checkSystemPrerequisites();
      }).toThrow(CurlNotFoundError);
    });

    it('does not mistake a directory for the curl executable', () => {
      pretendPlatform('linux');
      process.env.PATH = directory;
      expect(() => {
        makeConfig({ LATCHKEY_CURL: 'bin' }).checkSystemPrerequisites();
      }).toThrow(CurlNotFoundError);
    });
  });

  describe('checkSensitiveFilePermissions', () => {
    it.skipIf(originalPlatform === 'win32')(
      'rejects a world-readable credential store on POSIX',
      () => {
        pretendPlatform('linux');
        const config = makeConfig();
        writeFileSync(config.credentialStorePath, 'LATCHKEY_ENCRYPTED:', { mode: 0o644 });
        expect(() => {
          config.checkSensitiveFilePermissions();
        }).toThrow(InsecureFilePermissionsError);
      }
    );

    it('skips the permission bits check on Windows', () => {
      pretendPlatform('win32');
      const config = makeConfig();
      writeFileSync(config.credentialStorePath, 'LATCHKEY_ENCRYPTED:', { mode: 0o666 });
      expect(() => {
        config.checkSensitiveFilePermissions();
      }).not.toThrow();
    });
  });
});
