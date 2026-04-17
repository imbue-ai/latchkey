import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  Config,
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
    expect(config.countingDisabled).toBe(false);
    expect(config.permissionsConfigOverride).toBeNull();
    expect(config.permissionsDoNotUseBuiltinSchemas).toBe(false);
    expect(config.passthroughUnknown).toBe(false);
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
      countingDisabled: true,
      permissionsConfig: '/etc/latchkey/perm.json',
      permissionsDoNotUseBuiltinSchemas: true,
      passthroughUnknown: true,
      gateway: 'http://localhost:9000/',
      gatewayListenHost: '0.0.0.0',
      gatewayListenPort: 4242,
    });

    const config = makeConfig();

    expect(config.curlCommand).toBe('/usr/bin/custom-curl');
    expect(config.serviceName).toBe('file-service');
    expect(config.accountName).toBe('file-account');
    expect(config.browserDisabled).toBe(true);
    expect(config.countingDisabled).toBe(true);
    expect(config.permissionsConfigOverride).toBe('/etc/latchkey/perm.json');
    expect(config.permissionsDoNotUseBuiltinSchemas).toBe(true);
    expect(config.passthroughUnknown).toBe(true);
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
      LATCHKEY_DISABLE_COUNTING: '1',
      LATCHKEY_PERMISSIONS_CONFIG: '/env/perm.json',
      LATCHKEY_PERMISSIONS_DO_NOT_USE_BUILTIN_SCHEMAS: '1',
      LATCHKEY_PASSTHROUGH_UNKNOWN: '1',
      LATCHKEY_GATEWAY: 'http://env-gateway/',
      LATCHKEY_GATEWAY_LISTEN_HOST: '127.0.0.1',
      LATCHKEY_GATEWAY_LISTEN_PORT: '5555',
    });

    expect(config.curlCommand).toBe('/from/env');
    expect(config.serviceName).toBe('env-service');
    expect(config.accountName).toBe('env-account');
    expect(config.browserDisabled).toBe(true);
    expect(config.countingDisabled).toBe(true);
    expect(config.permissionsConfigOverride).toBe('/env/perm.json');
    expect(config.permissionsDoNotUseBuiltinSchemas).toBe(true);
    expect(config.passthroughUnknown).toBe(true);
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

  it('ignores an unparseable config.json entirely', () => {
    writeFileSync(join(directory, 'config.json'), 'not json{');

    const config = makeConfig();

    expect(config.curlCommand).toBe('curl');
  });
});
