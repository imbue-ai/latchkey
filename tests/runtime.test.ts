import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ApiCredentialStoreError,
  Config,
  createLatchkeyRuntime,
  CurlCommandConflictError,
  CurlNotFoundError,
  EncryptedStorage,
  EncryptedStorageError,
  EncryptionError,
  generateKey,
  InsecureFilePermissionsError,
  InvalidRuntimeDirectoryError,
  MigrationError,
  PluginLoadError,
  type LatchkeyRuntime,
  type LatchkeyRuntimeSettings,
} from '../src/embed.js';
import { getCurlCommand, resetCurlCommand } from '../src/curl.js';
import { LATEST_VERSION } from '../src/migrations.js';
import { resetClaimedCurlCommand } from '../src/runtime.js';

const DATA_FORMAT_VERSION_FILENAME = 'data-format-version';
const MISSING_CURL_COMMAND = 'latchkey-test-curl-that-is-not-installed';
// A program that is certainly installed and is not the default `curl`.
const OTHER_CURL_COMMAND = process.execPath;

const RAW_CURL_CREDENTIALS = {
  objectType: 'rawCurl',
  curlArguments: ['-H', 'Authorization: Bearer test-token'],
};

/** Where a bare Latchkey directory keeps its files. */
function pathsOf(directory: string): Config {
  return new Config(
    (name) => (name === 'LATCHKEY_DIRECTORY' ? directory : undefined),
    () => ({})
  );
}

function writeFileSettings(directory: string, settings: Readonly<Record<string, unknown>>): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ settings }), 'utf-8');
}

function writeCurrentFormatStore(directory: string, encryptionKey: string): void {
  new EncryptedStorage(encryptionKey).writeFile(
    pathsOf(directory).credentialStorePath,
    JSON.stringify({ credentials: { slack: { '': RAW_CURL_CREDENTIALS } }, preparations: {} })
  );
  writeFileSync(join(directory, DATA_FORMAT_VERSION_FILENAME), String(LATEST_VERSION), 'utf-8');
}

const PLUGIN_SOURCE = `
  export default (sdk) => {
    class FooService extends sdk.Service {
      constructor() {
        super();
        this.name = 'foo';
        this.displayName = 'Foo';
        this.baseApiUrls = ['https://foo.example.com/'];
        this.loginUrl = '';
        this.info = 'A service of a plugin.';
        this.credentialCheckCurlArguments = [];
      }
      setCredentialsExample(serviceName) {
        return \`latchkey auth set \${serviceName} -H "X-Foo: <token>"\`;
      }
    }
    class FooToken {
      static objectType = 'fooToken';
      objectType = 'fooToken';
      constructor(token) {
        this.token = token;
      }
      static fromJSON(data) {
        return new FooToken(data.token);
      }
      injectIntoCurlCall(curlArguments) {
        return Promise.resolve(['-H', \`X-Foo: \${this.token}\`, ...curlArguments]);
      }
      isExpired() {
        return undefined;
      }
      toJSON() {
        return { objectType: 'fooToken', token: this.token };
      }
    }
    return {
      latchkeyVersion: '>=3.15.0',
      services: [new FooService()],
      apiCredentialsTypes: [FooToken],
    };
  };
`;

describe('createLatchkeyRuntime', () => {
  let temporaryDirectory: string;
  let directory: string;
  let encryptionKey: string;

  function resetProcessWideCurlCommand(): void {
    resetClaimedCurlCommand();
    resetCurlCommand();
  }

  function createRuntime(
    runtimeDirectory: string,
    settings?: LatchkeyRuntimeSettings,
    key: string = encryptionKey
  ): Promise<LatchkeyRuntime> {
    return createLatchkeyRuntime({
      directory: runtimeDirectory,
      encryptionKey: key,
      settings,
      log: () => undefined,
      errorLog: () => undefined,
    });
  }

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'latchkey-runtime-test-'));
    directory = join(temporaryDirectory, 'latchkey');
    encryptionKey = generateKey();
    resetProcessWideCurlCommand();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetProcessWideCurlCommand();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  describe('settings', () => {
    interface SettingCase {
      readonly name: string;
      readonly read: (config: Config) => unknown;
      readonly expectedDefault: (runtimeDirectory: string) => unknown;
      /** The `settings` section of config.json, naming a value that is not the default. */
      readonly fileSettings: Readonly<Record<string, unknown>>;
      readonly expectedFromFile: unknown;
      /** What the caller passes, naming a value that is not the file's. */
      readonly callerSettings: LatchkeyRuntimeSettings;
      readonly expectedFromCaller: unknown;
    }

    const SETTING_CASES: readonly SettingCase[] = [
      {
        name: 'permissionsConfigPath',
        read: (config) => config.permissionsConfigPath,
        expectedDefault: (runtimeDirectory) => join(runtimeDirectory, 'permissions.json'),
        fileSettings: { permissionsConfig: '/from/file/permissions.json' },
        expectedFromFile: '/from/file/permissions.json',
        callerSettings: { permissionsConfigPath: '/from/caller/permissions.json' },
        expectedFromCaller: '/from/caller/permissions.json',
      },
      {
        name: 'permissionsDoNotUseBuiltinSchemas',
        read: (config) => config.permissionsDoNotUseBuiltinSchemas,
        expectedDefault: () => false,
        fileSettings: { permissionsDoNotUseBuiltinSchemas: true },
        expectedFromFile: true,
        callerSettings: { permissionsDoNotUseBuiltinSchemas: false },
        expectedFromCaller: false,
      },
      {
        name: 'passthroughUnknown',
        read: (config) => config.passthroughUnknown,
        expectedDefault: () => false,
        fileSettings: { passthroughUnknown: true },
        expectedFromFile: true,
        callerSettings: { passthroughUnknown: false },
        expectedFromCaller: false,
      },
      {
        name: 'diagnosticHeaders',
        read: (config) => config.diagnosticHeaders,
        expectedDefault: () => false,
        fileSettings: { diagnosticHeaders: true },
        expectedFromFile: true,
        callerSettings: { diagnosticHeaders: false },
        expectedFromCaller: false,
      },
      {
        name: 'credentialsRefreshDisabled',
        read: (config) => config.credentialsRefreshDisabled,
        expectedDefault: () => false,
        fileSettings: { credentialsRefreshDisabled: true },
        expectedFromFile: true,
        callerSettings: { credentialsRefreshDisabled: false },
        expectedFromCaller: false,
      },
      {
        name: 'hideBuiltinServices',
        read: (config) => config.hideBuiltinServices,
        expectedDefault: () => [],
        fileSettings: { hideBuiltinServices: ['slack'] },
        expectedFromFile: ['slack'],
        callerSettings: { hideBuiltinServices: ['discord'] },
        expectedFromCaller: ['discord'],
      },
      {
        name: 'browserDisabled',
        read: (config) => config.browserDisabled,
        expectedDefault: () => false,
        fileSettings: { browserDisabled: true },
        expectedFromFile: true,
        callerSettings: { browserDisabled: false },
        expectedFromCaller: false,
      },
      {
        name: 'browserEphemeral',
        read: (config) => config.browserEphemeral,
        expectedDefault: () => false,
        fileSettings: { browserEphemeral: true },
        expectedFromFile: true,
        callerSettings: { browserEphemeral: false },
        expectedFromCaller: false,
      },
      {
        name: 'appNamePrefix',
        read: (config) => config.appNamePrefix,
        expectedDefault: () => 'Latchkey',
        fileSettings: { appNamePrefix: 'FromFile' },
        expectedFromFile: 'FromFile',
        callerSettings: { appNamePrefix: 'FromCaller' },
        expectedFromCaller: 'FromCaller',
      },
    ];

    it.each(SETTING_CASES)('$name takes its default when nothing names it', async (settingCase) => {
      const runtime = await createRuntime(directory);

      expect(settingCase.read(runtime.config)).toEqual(settingCase.expectedDefault(directory));
    });

    it.each(SETTING_CASES)(
      '$name takes the value of config.json when the caller names none',
      async (settingCase) => {
        writeFileSettings(directory, settingCase.fileSettings);

        const runtime = await createRuntime(directory);

        expect(settingCase.read(runtime.config)).toEqual(settingCase.expectedFromFile);
      }
    );

    it.each(SETTING_CASES)(
      '$name takes the value the caller passes over that of config.json',
      async (settingCase) => {
        writeFileSettings(directory, settingCase.fileSettings);

        const runtime = await createRuntime(directory, settingCase.callerSettings);

        expect(settingCase.read(runtime.config)).toEqual(settingCase.expectedFromCaller);
      }
    );

    it('takes a boolean the caller passes as true over the false of config.json', async () => {
      writeFileSettings(directory, {
        permissionsDoNotUseBuiltinSchemas: false,
        passthroughUnknown: false,
        diagnosticHeaders: false,
        credentialsRefreshDisabled: false,
        browserDisabled: false,
        browserEphemeral: false,
      });

      const { config } = await createRuntime(directory, {
        permissionsDoNotUseBuiltinSchemas: true,
        passthroughUnknown: true,
        diagnosticHeaders: true,
        credentialsRefreshDisabled: true,
        browserDisabled: true,
        browserEphemeral: true,
      });

      expect({
        permissionsDoNotUseBuiltinSchemas: config.permissionsDoNotUseBuiltinSchemas,
        passthroughUnknown: config.passthroughUnknown,
        diagnosticHeaders: config.diagnosticHeaders,
        credentialsRefreshDisabled: config.credentialsRefreshDisabled,
        browserDisabled: config.browserDisabled,
        browserEphemeral: config.browserEphemeral,
      }).toEqual({
        permissionsDoNotUseBuiltinSchemas: true,
        passthroughUnknown: true,
        diagnosticHeaders: true,
        credentialsRefreshDisabled: true,
        browserDisabled: true,
        browserEphemeral: true,
      });
    });

    it('leaves the settings the caller does not name to config.json', async () => {
      writeFileSettings(directory, { appNamePrefix: 'FromFile', passthroughUnknown: true });

      const { config } = await createRuntime(directory, { appNamePrefix: 'FromCaller' });

      expect(config.appNamePrefix).toBe('FromCaller');
      expect(config.passthroughUnknown).toBe(true);
    });

    it('takes an empty list the caller passes over the list of config.json', async () => {
      writeFileSettings(directory, { hideBuiltinServices: ['slack'] });

      const runtime = await createRuntime(directory, { hideBuiltinServices: [] });

      expect(runtime.config.hideBuiltinServices).toEqual([]);
      expect(runtime.createServiceRegistry().getByName('slack')).not.toBeNull();
    });

    it('hides from its registries the services that hideBuiltinServices names', async () => {
      writeFileSettings(directory, { hideBuiltinServices: ['slack'] });

      const fromFile = await createRuntime(directory);
      const fromCaller = await createRuntime(directory, { hideBuiltinServices: ['discord'] });

      expect(fromFile.createServiceRegistry().getByName('slack')).toBeNull();
      expect(fromFile.createServiceRegistry().getByName('discord')).not.toBeNull();
      expect(fromCaller.createServiceRegistry().getByName('slack')).not.toBeNull();
      expect(fromCaller.createServiceRegistry().getByName('discord')).toBeNull();
    });

    it('takes curlCommand from the caller, then from config.json, then the default', async () => {
      const withDefault = await createRuntime(join(temporaryDirectory, 'default'));
      expect(withDefault.config.curlCommand).toBe('curl');
      expect(getCurlCommand()).toBe('curl');
      resetProcessWideCurlCommand();

      const fromFileDirectory = join(temporaryDirectory, 'from-file');
      writeFileSettings(fromFileDirectory, { curlCommand: OTHER_CURL_COMMAND });
      const fromFile = await createRuntime(fromFileDirectory);
      expect(fromFile.config.curlCommand).toBe(OTHER_CURL_COMMAND);
      expect(getCurlCommand()).toBe(OTHER_CURL_COMMAND);
      resetProcessWideCurlCommand();

      // The file names a program that cannot be found, so creating the
      // runtime succeeds only if the caller's value replaced it.
      const fromCallerDirectory = join(temporaryDirectory, 'from-caller');
      writeFileSettings(fromCallerDirectory, { curlCommand: MISSING_CURL_COMMAND });
      await expect(createRuntime(fromCallerDirectory)).rejects.toBeInstanceOf(CurlNotFoundError);
      const fromCaller = await createRuntime(fromCallerDirectory, {
        curlCommand: OTHER_CURL_COMMAND,
      });
      expect(fromCaller.config.curlCommand).toBe(OTHER_CURL_COMMAND);
      expect(getCurlCommand()).toBe(OTHER_CURL_COMMAND);
    });

    it('is not made a client of another gateway by a gateway URL in config.json', async () => {
      writeFileSettings(directory, { gateway: 'http://remote.example:1989' });
      const configOfCommandLine = new Config((name) =>
        name === 'LATCHKEY_DIRECTORY' ? directory : undefined
      );
      expect(configOfCommandLine.gatewayUrl).toBe('http://remote.example:1989');

      const runtime = await createRuntime(directory);

      expect(runtime.config.gatewayUrl).toBeNull();
    });
  });

  it('consults no environment variable', async () => {
    const directoryOfEnvironment = join(temporaryDirectory, 'from-environment');
    vi.stubEnv('LATCHKEY_ENV_OVERRIDES_FD', 'not-a-number');
    vi.stubEnv('LATCHKEY_DIRECTORY', directoryOfEnvironment);
    vi.stubEnv('LATCHKEY_ENCRYPTION_KEY', generateKey());
    vi.stubEnv('LATCHKEY_CURL', MISSING_CURL_COMMAND);
    vi.stubEnv('LATCHKEY_PASSTHROUGH_UNKNOWN', '1');
    vi.stubEnv('LATCHKEY_DIAGNOSTIC_HEADERS', '1');
    vi.stubEnv('LATCHKEY_DISABLE_BROWSER', '1');
    vi.stubEnv('LATCHKEY_DISABLE_CREDENTIALS_REFRESH', '1');
    vi.stubEnv('LATCHKEY_APP_NAME_PREFIX', 'FromEnvironment');
    vi.stubEnv('LATCHKEY_PERMISSIONS_CONFIG', '/from/environment/permissions.json');
    vi.stubEnv('LATCHKEY_HIDE_BUILTIN_SERVICES', 'slack');
    vi.stubEnv('LATCHKEY_GATEWAY', 'http://remote.example:1989');

    const { config } = await createRuntime(directory);

    expect(config.directory).toBe(directory);
    expect(existsSync(directoryOfEnvironment)).toBe(false);
    expect(config.encryptionKeyOverride).toBeNull();
    expect(config.curlCommand).toBe('curl');
    expect(config.passthroughUnknown).toBe(false);
    expect(config.diagnosticHeaders).toBe(false);
    expect(config.browserDisabled).toBe(false);
    expect(config.credentialsRefreshDisabled).toBe(false);
    expect(config.appNamePrefix).toBe('Latchkey');
    expect(config.permissionsConfigPath).toBe(join(directory, 'permissions.json'));
    expect(config.hideBuiltinServices).toEqual([]);
    expect(config.gatewayUrl).toBeNull();
    // Reading any of Latchkey's variables consumes the descriptor variable,
    // and fails on this value: a configuration that reads the environment
    // cannot even be built here.
    expect(process.env.LATCHKEY_ENV_OVERRIDES_FD).toBe('not-a-number');
    expect(() => new Config()).toThrow(/LATCHKEY_ENV_OVERRIDES_FD/);
  });

  describe('failures', () => {
    it('refuses a directory that is not absolute', async () => {
      await expect(createRuntime('relative/latchkey')).rejects.toBeInstanceOf(
        InvalidRuntimeDirectoryError
      );
      expect(existsSync('relative/latchkey')).toBe(false);
    });

    it.each([
      ['not base64 of 32 bytes', 'not-a-key'],
      ['too short', Buffer.alloc(16, 1).toString('base64')],
      ['empty', ''],
    ])('throws EncryptionError for a key that is %s', async (_description, malformedKey) => {
      await expect(createRuntime(directory, undefined, malformedKey)).rejects.toBeInstanceOf(
        EncryptionError
      );
      expect(existsSync(directory)).toBe(false);
    });

    it('throws CurlNotFoundError when the curl program cannot be found', async () => {
      await expect(
        createRuntime(directory, { curlCommand: MISSING_CURL_COMMAND })
      ).rejects.toBeInstanceOf(CurlNotFoundError);
      expect(getCurlCommand()).toBe('curl');
    });

    it.skipIf(process.platform === 'win32').each([
      ['the credential store', (config: Config) => config.credentialStorePath, 0o644],
      ['the credential store', (config: Config) => config.credentialStorePath, 0o640],
      ['the browser state', (config: Config) => config.browserStatePath, 0o604],
    ])(
      'throws InsecureFilePermissionsError when %s is readable beyond its owner',
      async (_description, pathOf, mode) => {
        const sensitiveFilePath = pathOf(pathsOf(directory));
        new EncryptedStorage(encryptionKey).writeFile(sensitiveFilePath, '{}');
        chmodSync(sensitiveFilePath, mode);

        await expect(createRuntime(directory)).rejects.toBeInstanceOf(InsecureFilePermissionsError);

        chmodSync(sensitiveFilePath, 0o600);
        await expect(createRuntime(directory)).resolves.toBeDefined();
      }
    );

    it('throws PluginLoadError for a plugin that cannot be loaded', async () => {
      mkdirSync(join(directory, 'plugins', 'broken'), { recursive: true });

      const creation = createRuntime(directory);

      await expect(creation).rejects.toBeInstanceOf(PluginLoadError);
      await expect(creation).rejects.toThrow("Failed to load plugin 'broken'");
    });

    it('throws MigrationError for a directory in a newer data format', async () => {
      writeCurrentFormatStore(directory, encryptionKey);
      writeFileSync(
        join(directory, DATA_FORMAT_VERSION_FILENAME),
        String(LATEST_VERSION + 1),
        'utf-8'
      );

      await expect(createRuntime(directory)).rejects.toBeInstanceOf(MigrationError);
    });

    it.skipIf(process.platform === 'win32')(
      'throws the error of the first step that fails',
      async () => {
        const storePath = pathsOf(directory).credentialStorePath;
        const pluginDirectory = join(directory, 'plugins', 'broken');
        const versionFilePath = join(directory, DATA_FORMAT_VERSION_FILENAME);
        writeCurrentFormatStore(directory, encryptionKey);
        chmodSync(storePath, 0o644);
        mkdirSync(pluginDirectory, { recursive: true });
        writeFileSync(versionFilePath, String(LATEST_VERSION + 1), 'utf-8');
        const missingCurl: LatchkeyRuntimeSettings = { curlCommand: MISSING_CURL_COMMAND };

        await expect(createRuntime('relative/latchkey', missingCurl, '')).rejects.toBeInstanceOf(
          InvalidRuntimeDirectoryError
        );
        await expect(createRuntime(directory, missingCurl, '')).rejects.toBeInstanceOf(
          EncryptionError
        );
        await expect(createRuntime(directory, missingCurl)).rejects.toBeInstanceOf(
          CurlNotFoundError
        );
        await expect(createRuntime(directory)).rejects.toBeInstanceOf(InsecureFilePermissionsError);

        chmodSync(storePath, 0o600);
        await expect(createRuntime(directory)).rejects.toBeInstanceOf(PluginLoadError);

        rmSync(pluginDirectory, { recursive: true });
        await expect(createRuntime(directory)).rejects.toBeInstanceOf(MigrationError);

        writeFileSync(versionFilePath, String(LATEST_VERSION), 'utf-8');
        const runtime = await createRuntime(directory);
        expect(runtime.apiCredentialStore.listAccounts('slack')).toEqual(['']);
      }
    );
  });

  it('creates a directory that has no store and stamps it with the newest data format', async () => {
    expect(existsSync(directory)).toBe(false);

    const runtime = await createRuntime(directory);

    expect(readFileSync(join(directory, DATA_FORMAT_VERSION_FILENAME), 'utf-8')).toBe(
      String(LATEST_VERSION)
    );
    expect(existsSync(runtime.config.credentialStorePath)).toBe(false);
    expect(runtime.apiCredentialStore.getAll().size).toBe(0);
  });

  it('is created with a key that cannot open the store, and fails when the store is read', async () => {
    writeCurrentFormatStore(directory, encryptionKey);

    const withStoreKey = await createRuntime(directory);
    const withOtherKey = await createRuntime(directory, undefined, generateKey());

    expect([...withStoreKey.apiCredentialStore.getAll().keys()]).toEqual(['slack']);
    expect(() => withOtherKey.apiCredentialStore.getAll()).toThrow(ApiCredentialStoreError);
  });

  it('fails with EncryptedStorageError for a store in an older data format that the key cannot open', async () => {
    // A store in an older format has to be read to be migrated, so a key that
    // cannot open it is found when the runtime is created, not later.
    new EncryptedStorage(encryptionKey).writeFile(
      pathsOf(directory).credentialStorePath,
      JSON.stringify({ 'internal-api': RAW_CURL_CREDENTIALS })
    );

    await expect(createRuntime(directory, undefined, generateKey())).rejects.toBeInstanceOf(
      EncryptedStorageError
    );
    expect(existsSync(join(directory, DATA_FORMAT_VERSION_FILENAME))).toBe(false);
  });

  it('lists the services and the credential types of the plugins after its own', async () => {
    mkdirSync(join(directory, 'plugins', 'foo'), { recursive: true });
    writeFileSync(join(directory, 'plugins', 'foo', 'index.js'), PLUGIN_SOURCE, 'utf-8');

    const runtime = await createRuntime(directory);

    const serviceNames = runtime.baseServices.map((service) => service.name);
    expect(serviceNames.at(-1)).toBe('foo');
    expect(serviceNames).toContain('slack');
    const objectTypes = runtime.apiCredentialsTypes.map((type) => type.objectType);
    expect(objectTypes.at(-1)).toBe('fooToken');
    expect(objectTypes).toContain('rawCurl');
    expect(runtime.createServiceRegistry().getByName('foo')).not.toBeNull();

    // The store of the runtime holds credentials of the plugin's type.
    const fooTokenData = { objectType: 'fooToken', token: 'secret' };
    const fooTokenType = runtime.apiCredentialsTypes.at(-1)!;
    runtime.apiCredentialStore.save('foo', fooTokenType.fromJSON(fooTokenData));
    expect(runtime.apiCredentialStore.get('foo')?.toJSON?.()).toEqual(fooTokenData);
  });

  it('lists only its own services and credential types for a directory without plugins', async () => {
    const runtime = await createRuntime(directory);

    expect(runtime.baseServices.map((service) => service.name)).not.toContain('foo');
    expect(runtime.apiCredentialsTypes.map((type) => type.objectType)).not.toContain('fooToken');
  });

  describe('the curl program of the process', () => {
    it('refuses a second runtime whose curlCommand differs', async () => {
      await createRuntime(join(temporaryDirectory, 'first'));

      await expect(
        createRuntime(join(temporaryDirectory, 'second'), { curlCommand: OTHER_CURL_COMMAND })
      ).rejects.toBeInstanceOf(CurlCommandConflictError);
      expect(getCurlCommand()).toBe('curl');
    });

    it('refuses a second runtime that falls back to the default when the first named another', async () => {
      await createRuntime(join(temporaryDirectory, 'first'), { curlCommand: OTHER_CURL_COMMAND });

      await expect(createRuntime(join(temporaryDirectory, 'second'))).rejects.toBeInstanceOf(
        CurlCommandConflictError
      );
      expect(getCurlCommand()).toBe(OTHER_CURL_COMMAND);
    });

    it('gives back the claim of a runtime whose creation failed', async () => {
      // The creation claims the default curl and then fails in its migrations.
      const failingDirectory = join(temporaryDirectory, 'failing');
      new EncryptedStorage(encryptionKey).writeFile(
        pathsOf(failingDirectory).credentialStorePath,
        JSON.stringify({ 'internal-api': RAW_CURL_CREDENTIALS })
      );
      await expect(
        createRuntime(failingDirectory, undefined, generateKey())
      ).rejects.toBeInstanceOf(EncryptedStorageError);

      const runtime = await createRuntime(join(temporaryDirectory, 'second'), {
        curlCommand: OTHER_CURL_COMMAND,
      });

      expect(runtime.config.curlCommand).toBe(OTHER_CURL_COMMAND);
      expect(getCurlCommand()).toBe(OTHER_CURL_COMMAND);
    });

    it('restores the claim of an earlier runtime when a later creation fails', async () => {
      await createRuntime(join(temporaryDirectory, 'first'), { curlCommand: OTHER_CURL_COMMAND });
      const failingDirectory = join(temporaryDirectory, 'failing');
      new EncryptedStorage(encryptionKey).writeFile(
        pathsOf(failingDirectory).credentialStorePath,
        JSON.stringify({ 'internal-api': RAW_CURL_CREDENTIALS })
      );

      await expect(
        createRuntime(failingDirectory, { curlCommand: OTHER_CURL_COMMAND }, generateKey())
      ).rejects.toBeInstanceOf(EncryptedStorageError);

      expect(getCurlCommand()).toBe(OTHER_CURL_COMMAND);
      await expect(createRuntime(join(temporaryDirectory, 'third'))).rejects.toBeInstanceOf(
        CurlCommandConflictError
      );
    });

    it('accepts a second runtime with the same curlCommand', async () => {
      const first = await createRuntime(join(temporaryDirectory, 'first'), {
        curlCommand: OTHER_CURL_COMMAND,
      });
      const second = await createRuntime(join(temporaryDirectory, 'second'), {
        curlCommand: OTHER_CURL_COMMAND,
      });

      expect(second.config.curlCommand).toBe(OTHER_CURL_COMMAND);
      expect(second.config.directory).not.toBe(first.config.directory);
      expect(getCurlCommand()).toBe(OTHER_CURL_COMMAND);
    });
  });
});
