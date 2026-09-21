import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PluginLoadError,
  combineWithPluginApiCredentialsTypes,
  combineWithPluginServices,
  isLatchkeyVersionSupported,
  loadPlugins,
  type LoadedPlugin,
} from '../src/plugins.js';
import { createLatchkeySdk } from '../src/pluginSdk.js';
import { type ApiCredentialsType, AuthorizationBearer } from '../src/apiCredentials/base.js';
import { BUILTIN_API_CREDENTIALS_TYPES } from '../src/apiCredentials/serialization.js';
import { Service } from '../src/services/core/base.js';
import { SLACK } from '../src/services/index.js';
import { VERSION } from '../src/version.js';

const SDK_VERSION = '3.15.2';
const SDK = createLatchkeySdk(SDK_VERSION);
const SUPPORTED_VERSION_RANGE = '^3.15.0';

interface PluginSourceOptions {
  readonly latchkeyVersion?: unknown;
  readonly asyncFactory?: boolean;
  /** JavaScript for the manifest's `apiCredentialsTypes`, evaluated with `sdk` in scope. */
  readonly apiCredentialsTypes?: string;
}

function pluginSource(serviceNames: readonly string[], options: PluginSourceOptions = {}): string {
  const latchkeyVersion = JSON.stringify(options.latchkeyVersion ?? SUPPORTED_VERSION_RANGE);
  const services = serviceNames.map((name) => `new PluginService(${JSON.stringify(name)})`);
  const factory = options.asyncFactory === true ? 'async (sdk)' : '(sdk)';
  return `
    export default ${factory} => {
      class PluginService extends sdk.Service {
        constructor(name) {
          super();
          this.name = name;
          this.displayName = name;
          this.baseApiUrls = [\`https://\${name}.example.com/\`];
          this.loginUrl = '';
          this.info = \`Plugin service \${name}, loaded by Latchkey \${sdk.latchkeyVersion}.\`;
          this.credentialCheckCurlArguments = [];
        }
        setCredentialsExample(serviceName) {
          return \`latchkey auth set \${serviceName} -H "Authorization: Bearer <token>"\`;
        }
      }
      return {
        latchkeyVersion: ${latchkeyVersion},
        services: [${services.join(', ')}],
        ${options.apiCredentialsTypes === undefined ? '' : `apiCredentialsTypes: ${options.apiCredentialsTypes},`}
      };
    };
  `;
}

function writePlugin(
  pluginsDirectory: string,
  pluginName: string,
  files: Readonly<Record<string, string>>
): string {
  const pluginDirectory = join(pluginsDirectory, pluginName);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = join(pluginDirectory, relativePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, 'utf-8');
  }
  return pluginDirectory;
}

function serviceNames(plugin: LoadedPlugin): readonly string[] {
  return plugin.services.map((service) => service.name);
}

async function expectLoadError(pluginsDirectory: string, messagePart: string): Promise<void> {
  const loading = loadPlugins(pluginsDirectory, SDK);
  await expect(loading).rejects.toBeInstanceOf(PluginLoadError);
  await expect(loading).rejects.toThrow(messagePart);
}

describe('loadPlugins', () => {
  let tempDir: string;
  let pluginsDirectory: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'latchkey-plugins-test-'));
    pluginsDirectory = join(tempDir, 'plugins');
    mkdirSync(pluginsDirectory);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns no plugins when the directory does not exist', async () => {
    expect(await loadPlugins(join(tempDir, 'nonexistent'), SDK)).toEqual([]);
  });

  it('returns no plugins when the path is a file', async () => {
    const filePath = join(tempDir, 'not-a-directory');
    writeFileSync(filePath, '', 'utf-8');
    expect(await loadPlugins(filePath, SDK)).toEqual([]);
  });

  it('loads a plugin from its index.js and hands its factory the sdk', async () => {
    const pluginDirectory = writePlugin(pluginsDirectory, 'foo', {
      'index.js': pluginSource(['foo', 'foo-admin']),
    });

    const plugins = await loadPlugins(pluginsDirectory, SDK);

    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.name).toBe('foo');
    expect(plugins[0]!.directory).toBe(pluginDirectory);
    expect(serviceNames(plugins[0]!)).toEqual(['foo', 'foo-admin']);
    expect(plugins[0]!.services[0]).toBeInstanceOf(Service);
    expect(plugins[0]!.services[0]!.info).toContain(`loaded by Latchkey ${SDK_VERSION}`);
  });

  it('loads plugins in alphabetical order and ignores what is not a plugin directory', async () => {
    writePlugin(pluginsDirectory, 'zeta', { 'index.js': pluginSource(['zeta']) });
    writePlugin(pluginsDirectory, 'alpha', { 'index.js': pluginSource(['alpha']) });
    writePlugin(pluginsDirectory, '.hidden', { 'index.js': pluginSource(['hidden']) });
    writePlugin(pluginsDirectory, 'node_modules', { 'index.js': pluginSource(['dependency']) });
    writeFileSync(join(pluginsDirectory, 'stray.js'), pluginSource(['stray']), 'utf-8');

    const plugins = await loadPlugins(pluginsDirectory, SDK);

    expect(plugins.map((plugin) => plugin.name)).toEqual(['alpha', 'zeta']);
  });

  it('follows a symlink to a plugin checkout elsewhere', async () => {
    const checkout = join(tempDir, 'checkout');
    writePlugin(tempDir, 'checkout', { 'index.js': pluginSource(['linked']) });
    symlinkSync(checkout, join(pluginsDirectory, 'linked'));

    const plugins = await loadPlugins(pluginsDirectory, SDK);

    expect(plugins.map((plugin) => plugin.name)).toEqual(['linked']);
    expect(serviceNames(plugins[0]!)).toEqual(['linked']);
  });

  it('supports an asynchronous factory', async () => {
    writePlugin(pluginsDirectory, 'foo', {
      'index.js': pluginSource(['foo'], { asyncFactory: true }),
    });

    const plugins = await loadPlugins(pluginsDirectory, SDK);

    expect(serviceNames(plugins[0]!)).toEqual(['foo']);
  });

  it('loads a plugin without credentials types as contributing none', async () => {
    writePlugin(pluginsDirectory, 'foo', { 'index.js': pluginSource(['foo']) });

    const plugins = await loadPlugins(pluginsDirectory, SDK);

    expect(plugins[0]!.apiCredentialsTypes).toEqual([]);
  });

  it('loads the credentials classes a plugin defines', async () => {
    writePlugin(pluginsDirectory, 'foo', {
      'index.js': pluginSource(['foo'], {
        apiCredentialsTypes: `[
          class FooToken extends sdk.AuthorizationBearer {
            static objectType = 'fooToken';
            static fromJSON(data) {
              return new FooToken(data.token);
            }
          },
        ]`,
      }),
    });

    const plugins = await loadPlugins(pluginsDirectory, SDK);

    const [type] = plugins[0]!.apiCredentialsTypes;
    expect(type!.objectType).toBe('fooToken');
    expect(type!.fromJSON({ objectType: 'fooToken', token: 't' })).toBeInstanceOf(
      AuthorizationBearer
    );
  });

  describe('entry file', () => {
    it('honors the main field of package.json', async () => {
      writePlugin(pluginsDirectory, 'foo', {
        'package.json': JSON.stringify({ type: 'module', main: 'dist/plugin.js' }),
        'dist/plugin.js': pluginSource(['foo']),
        'index.js': 'throw new Error("index.js must not be loaded");',
      });

      const plugins = await loadPlugins(pluginsDirectory, SDK);

      expect(serviceNames(plugins[0]!)).toEqual(['foo']);
    });

    it.each([
      ['a string', './dist/plugin.js'],
      ['a root subpath', { '.': './dist/plugin.js' }],
      ['conditions', { import: './dist/plugin.js', require: './dist/plugin.cjs' }],
      [
        'a root subpath with conditions',
        { '.': { types: './x.d.ts', default: './dist/plugin.js' } },
      ],
    ])('honors an exports field of package.json that is %s', async (_description, exportsField) => {
      writePlugin(pluginsDirectory, 'foo', {
        'package.json': JSON.stringify({ type: 'module', main: 'wrong.js', exports: exportsField }),
        'dist/plugin.js': pluginSource(['foo']),
      });

      const plugins = await loadPlugins(pluginsDirectory, SDK);

      expect(serviceNames(plugins[0]!)).toEqual(['foo']);
    });

    it('falls back from an exports field without a usable entry to main', async () => {
      writePlugin(pluginsDirectory, 'foo', {
        'package.json': JSON.stringify({
          type: 'module',
          main: 'dist/plugin.js',
          exports: { './helpers': './dist/helpers.js' },
        }),
        'dist/plugin.js': pluginSource(['foo']),
      });

      const plugins = await loadPlugins(pluginsDirectory, SDK);

      expect(serviceNames(plugins[0]!)).toEqual(['foo']);
    });

    it('rejects a plugin whose package.json is not valid JSON', async () => {
      writePlugin(pluginsDirectory, 'foo', {
        'package.json': '{ not json',
        'index.js': pluginSource(['foo']),
      });

      await expectLoadError(pluginsDirectory, "Failed to load plugin 'foo': invalid package.json");
    });

    it('rejects a plugin whose entry file is missing, hinting at an unbuilt checkout', async () => {
      writePlugin(pluginsDirectory, 'foo', {
        'package.json': JSON.stringify({ type: 'module', main: 'dist/index.js' }),
        'src/index.ts': 'export default () => ({ latchkeyVersion: "^3.15.0", services: [] });',
      });

      await expectLoadError(pluginsDirectory, 'has to be built first');
    });
  });

  describe('validation', () => {
    it('rejects a plugin that fails to import', async () => {
      writePlugin(pluginsDirectory, 'foo', { 'index.js': 'export default (' });

      await expectLoadError(pluginsDirectory, "Failed to load plugin 'foo': could not import");
    });

    it('rejects a plugin without a default export', async () => {
      writePlugin(pluginsDirectory, 'foo', { 'index.js': 'export const services = [];' });

      await expectLoadError(pluginsDirectory, 'must have a default export that is a function');
    });

    it('rejects a plugin whose default export is not a function', async () => {
      writePlugin(pluginsDirectory, 'foo', {
        'index.js': 'export default { latchkeyVersion: "^3.15.0", services: [] };',
      });

      await expectLoadError(pluginsDirectory, 'must have a default export that is a function');
    });

    it('rejects a plugin whose factory throws', async () => {
      writePlugin(pluginsDirectory, 'foo', {
        'index.js': 'export default () => { throw new Error("no network"); };',
      });

      await expectLoadError(pluginsDirectory, 'the plugin factory threw: no network');
    });

    it('rejects a plugin whose factory does not return an object', async () => {
      writePlugin(pluginsDirectory, 'foo', { 'index.js': 'export default () => undefined;' });

      await expectLoadError(pluginsDirectory, 'did not return an object');
    });

    it('rejects a plugin that does not declare the Latchkey versions it supports', async () => {
      writePlugin(pluginsDirectory, 'foo', {
        'index.js': 'export default () => ({ services: [] });',
      });

      await expectLoadError(pluginsDirectory, "'latchkeyVersion' must be a string");
    });

    it('rejects a plugin declaring the Latchkey version as a number', async () => {
      writePlugin(pluginsDirectory, 'foo', {
        'index.js': pluginSource(['foo'], { latchkeyVersion: 3 }),
      });

      await expectLoadError(pluginsDirectory, "'latchkeyVersion' must be a string");
    });

    it('rejects a plugin declaring an invalid version range', async () => {
      writePlugin(pluginsDirectory, 'foo', {
        'index.js': pluginSource(['foo'], { latchkeyVersion: 'latest and greatest' }),
      });

      await expectLoadError(
        pluginsDirectory,
        "'latest and greatest' is not a valid version range for 'latchkeyVersion'"
      );
    });

    it.each(['^4.0.0', '^3.16.0', '~3.14.0', '<3.15.2', '2.x'])(
      'rejects a plugin whose version range %s excludes this Latchkey',
      async (latchkeyVersion) => {
        writePlugin(pluginsDirectory, 'foo', {
          'index.js': pluginSource(['foo'], { latchkeyVersion }),
        });

        await expectLoadError(
          pluginsDirectory,
          `it supports Latchkey ${latchkeyVersion}, but this is Latchkey ${SDK_VERSION}.`
        );
      }
    );

    it.each(['^3.15.0', '^3.0.0', '~3.15.0', '3.15.2', '3.x', '>=3.15.0 <4', '*'])(
      'accepts a plugin whose version range %s includes this Latchkey',
      async (latchkeyVersion) => {
        writePlugin(pluginsDirectory, 'foo', {
          'index.js': pluginSource(['foo'], { latchkeyVersion }),
        });

        const plugins = await loadPlugins(pluginsDirectory, SDK);

        expect(serviceNames(plugins[0]!)).toEqual(['foo']);
      }
    );

    it('rejects a plugin without a services array', async () => {
      writePlugin(pluginsDirectory, 'foo', {
        'index.js': 'export default () => ({ latchkeyVersion: "^3.15.0", services: {} });',
      });

      await expectLoadError(pluginsDirectory, "'services' must be an array");
    });

    it('rejects a service that does not extend the Service class', async () => {
      writePlugin(pluginsDirectory, 'foo', {
        'index.js': `export default () => ({
          latchkeyVersion: '^3.15.0',
          services: [{ name: 'foo', displayName: 'Foo', baseApiUrls: [], loginUrl: '', info: '' }],
        });`,
      });

      await expectLoadError(pluginsDirectory, 'must extend the Service class');
    });

    it('rejects a service extending a Service class other than the one in the sdk', async () => {
      // What a second, separately installed copy of latchkey would produce.
      writePlugin(pluginsDirectory, 'foo', {
        'index.js': `
          class Service {}
          class Foo extends Service { name = 'foo'; }
          export default () => ({ latchkeyVersion: '^3.15.0', services: [new Foo()] });
        `,
      });

      await expectLoadError(pluginsDirectory, 'separately installed latchkey');
    });

    it('rejects credentials types that are not an array', async () => {
      writePlugin(pluginsDirectory, 'foo', {
        'index.js': pluginSource(['foo'], { apiCredentialsTypes: '{}' }),
      });

      await expectLoadError(pluginsDirectory, "'apiCredentialsTypes' must be an array");
    });

    it('rejects a credentials class without a static fromJSON', async () => {
      writePlugin(pluginsDirectory, 'foo', {
        'index.js': pluginSource(['foo'], {
          apiCredentialsTypes: "[class FooToken { static objectType = 'fooToken'; }]",
        }),
      });

      await expectLoadError(
        pluginsDirectory,
        "every entry of 'apiCredentialsTypes' must be a credentials class with a static " +
          "'objectType' and a static 'fromJSON'."
      );
    });

    it('reports the first broken plugin and loads none', async () => {
      writePlugin(pluginsDirectory, 'a-fine', { 'index.js': pluginSource(['fine']) });
      writePlugin(pluginsDirectory, 'b-broken', { 'index.js': 'export default 42;' });

      await expectLoadError(pluginsDirectory, "Failed to load plugin 'b-broken'");
    });
  });
});

describe('isLatchkeyVersionSupported', () => {
  it('accepts a release within the range', () => {
    expect(isLatchkeyVersionSupported('^3.15.0', '3.15.0')).toBe(true);
    expect(isLatchkeyVersionSupported('^3.15.0', '3.99.1')).toBe(true);
  });

  it('rejects a release outside the range', () => {
    expect(isLatchkeyVersionSupported('^3.15.0', '3.14.9')).toBe(false);
    expect(isLatchkeyVersionSupported('^3.15.0', '4.0.0')).toBe(false);
  });

  it('accepts a prerelease of a version within the range', () => {
    expect(isLatchkeyVersionSupported('^3.15.0', '3.16.0-dev.1')).toBe(true);
  });

  it('rejects a prerelease of a version outside the range', () => {
    expect(isLatchkeyVersionSupported('^3.15.0', '3.15.0-dev.1')).toBe(false);
    expect(isLatchkeyVersionSupported('^3.15.0', '4.0.0-rc.1')).toBe(false);
  });
});

describe('combineWithPluginServices', () => {
  function loadedPlugin(
    name: string,
    services: readonly Service[],
    apiCredentialsTypes: readonly ApiCredentialsType[] = []
  ): LoadedPlugin {
    return { name, directory: `/plugins/${name}`, services, apiCredentialsTypes };
  }

  class NamedService extends Service {
    readonly displayName: string;
    readonly baseApiUrls = [];
    readonly loginUrl = '';
    readonly info = '';
    readonly credentialCheckCurlArguments = [];

    constructor(readonly name: string) {
      super();
      this.displayName = name;
    }

    setCredentialsExample(serviceName: string): string {
      return `latchkey auth set ${serviceName}`;
    }
  }

  it('appends plugin services after the built-in ones, in plugin order', () => {
    const foo = new NamedService('foo');
    const bar = new NamedService('bar');

    const combined = combineWithPluginServices(
      [SLACK],
      [loadedPlugin('a', [foo]), loadedPlugin('b', [bar])]
    );

    expect(combined).toEqual([SLACK, foo, bar]);
  });

  it('refuses a plugin service named like a built-in one', () => {
    expect(() =>
      combineWithPluginServices([SLACK], [loadedPlugin('a', [new NamedService('slack')])])
    ).toThrow("Failed to load plugin 'a': service 'slack' is already provided by Latchkey itself.");
  });

  it('refuses a plugin service named like one from an earlier plugin', () => {
    expect(() =>
      combineWithPluginServices(
        [],
        [loadedPlugin('a', [new NamedService('foo')]), loadedPlugin('b', [new NamedService('foo')])]
      )
    ).toThrow("Failed to load plugin 'b': service 'foo' is already provided by plugin 'a'.");
  });
});

describe('combineWithPluginApiCredentialsTypes', () => {
  function loadedPlugin(name: string, apiCredentialsTypes: readonly ApiCredentialsType[]) {
    return { name, directory: `/plugins/${name}`, services: [], apiCredentialsTypes };
  }

  function namedType(objectType: string): ApiCredentialsType {
    return { objectType, fromJSON: () => new AuthorizationBearer('') };
  }

  it('appends plugin credentials types after the built-in ones, in plugin order', () => {
    const foo = namedType('foo');
    const bar = namedType('bar');

    const combined = combineWithPluginApiCredentialsTypes(BUILTIN_API_CREDENTIALS_TYPES, [
      loadedPlugin('a', [foo]),
      loadedPlugin('b', [bar]),
    ]);

    expect(combined).toEqual([...BUILTIN_API_CREDENTIALS_TYPES, foo, bar]);
  });

  it('refuses a plugin credentials type named like a built-in one', () => {
    expect(() =>
      combineWithPluginApiCredentialsTypes(BUILTIN_API_CREDENTIALS_TYPES, [
        loadedPlugin('a', [namedType('oauth')]),
      ])
    ).toThrow(
      "Failed to load plugin 'a': credentials type 'oauth' is already provided by Latchkey itself."
    );
  });

  it('refuses a plugin credentials type named like one from an earlier plugin', () => {
    expect(() =>
      combineWithPluginApiCredentialsTypes(
        [],
        [loadedPlugin('a', [namedType('foo')]), loadedPlugin('b', [namedType('foo')])]
      )
    ).toThrow(
      "Failed to load plugin 'b': credentials type 'foo' is already provided by plugin 'a'."
    );
  });
});

// ─── End to end: a plugin served by the real CLI ──────────────────────────────

const TEST_ENCRYPTION_KEY = 'dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleXRlc3Q=';
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const devShimPath = join(projectRoot, 'scripts', 'latchkey');

/**
 * What a real plugin looks like: an ES module package with nothing installed
 * in its own node_modules, taking everything, zod included, from the sdk. It
 * also brings a credentials class of its own, which the sdk lets it register.
 */
const REAL_PLUGIN_SOURCE = `
  export default (sdk) => {
    const { Service, AuthorizationBearer, buildPreparedCredentials, z } = sdk;

    const ExampleTokenSchema = z.object({ objectType: z.literal('exampleToken'), token: z.string() });

    class ExampleToken {
      static objectType = 'exampleToken';
      objectType = ExampleToken.objectType;
      constructor(token) {
        this.token = token;
      }
      static fromJSON(data) {
        return new ExampleToken(ExampleTokenSchema.parse(data).token);
      }
      injectIntoCurlCall(curlArguments) {
        return Promise.resolve(['-H', \`X-Example-Token: \${this.token}\`, ...curlArguments]);
      }
      isExpired() {
        return undefined;
      }
      toJSON() {
        return { objectType: this.objectType, token: this.token };
      }
    }

    class Example extends Service {
      name = 'example';
      displayName = 'Example';
      baseApiUrls = ['https://api.example.com/'];
      loginUrl = 'https://example.com/login';
      info = 'Example plugin service.';
      credentialCheckCurlArguments = ['https://api.example.com/me'];

      setCredentialsExample(serviceName) {
        return \`latchkey auth set \${serviceName} -H "Authorization: Bearer <token>"\`;
      }

      prepareFromJson(parsedJson) {
        return buildPreparedCredentials(
          this.name,
          z.object({ token: z.string() }),
          parsedJson,
          (input) => new AuthorizationBearer(input.token)
        );
      }

      getCredentialsNoCurl(noCurlArguments) {
        return new ExampleToken(noCurlArguments[0]);
      }
    }

    return {
      latchkeyVersion: ${JSON.stringify(`^${VERSION}`)},
      services: [new Example()],
      apiCredentialsTypes: [ExampleToken],
    };
  };
`;

interface CliRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(latchkeyDirectory: string, args: readonly string[]): CliRunResult {
  try {
    const stdout = execFileSync(devShimPath, args, {
      cwd: projectRoot,
      encoding: 'utf-8',
      env: {
        ...process.env,
        LATCHKEY_DIRECTORY: latchkeyDirectory,
        LATCHKEY_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
        LATCHKEY_DISABLE_COUNTING: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status: number | null; stdout: string; stderr: string };
    return { exitCode: failure.status ?? 1, stdout: failure.stdout, stderr: failure.stderr };
  }
}

describe('plugins loaded by the CLI', () => {
  let latchkeyDirectory: string;

  beforeEach(() => {
    latchkeyDirectory = mkdtempSync(join(tmpdir(), 'latchkey-plugins-cli-test-'));
    writePlugin(join(latchkeyDirectory, 'plugins'), 'latchkey-plugin-example', {
      'package.json': JSON.stringify({ name: 'latchkey-plugin-example', type: 'module' }),
      'index.js': REAL_PLUGIN_SOURCE,
    });
  });

  afterEach(() => {
    rmSync(latchkeyDirectory, { recursive: true, force: true });
  });

  it('serves a plugin service built from the sdk, zod included, like a built-in one', () => {
    const preparation = runCli(latchkeyDirectory, ['auth', 'prepare', 'example', '{"token":"t"}']);
    expect(preparation.stderr).toBe('');
    expect(preparation.exitCode).toBe(0);

    const info = runCli(latchkeyDirectory, ['services', 'info', 'example', '--offline']);
    expect(info.stderr).toBe('');
    expect(info.exitCode).toBe(0);
    const parsedInfo = JSON.parse(info.stdout) as { type: string; developerNotes: string };
    expect(parsedInfo.type).toBe('built-in');
    expect(parsedInfo.developerNotes).toBe('Example plugin service.');
  }, 60_000);

  it('stores and reads back credentials of a class the plugin defines', () => {
    const setting = runCli(latchkeyDirectory, ['auth', 'set-nocurl', 'example', 't0ken']);
    expect(setting.stderr).toBe('');
    expect(setting.exitCode).toBe(0);

    const info = runCli(latchkeyDirectory, ['services', 'info', 'example', '--offline']);
    expect(info.stderr).toBe('');
    expect(info.exitCode).toBe(0);
    const parsedInfo = JSON.parse(info.stdout) as { credentials: Record<string, unknown> };
    expect(Object.values(parsedInfo.credentials)).toEqual([
      { credentialStatus: 'unknown', credentialType: 'exampleToken' },
    ]);
  }, 60_000);

  it('refuses to start with a broken plugin and names it', () => {
    writePlugin(join(latchkeyDirectory, 'plugins'), 'broken', {
      'package.json': JSON.stringify({ type: 'module' }),
      'index.js': 'export default () => ({ latchkeyVersion: "^1.0.0", services: [] });',
    });

    const result = runCli(latchkeyDirectory, ['services', 'list', '--builtin']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Error: Failed to load plugin 'broken'");
    expect(result.stderr).toContain(
      `it supports Latchkey ^1.0.0, but this is Latchkey ${VERSION}.`
    );
  }, 60_000);
});
