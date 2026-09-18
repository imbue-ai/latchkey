/**
 * Plugins: services contributed by repositories cloned into the plugins
 * directory (`~/.latchkey/plugins/` by default). Once loaded, their services
 * are indistinguishable from the built-in ones.
 *
 * A plugin is an ES module package whose default export is a factory. It is
 * handed a {@link LatchkeySdk} and returns a {@link LatchkeyPlugin}:
 *
 *   export default (sdk) => {
 *     class Foo extends sdk.Service { ... }
 *     return { apiVersion: 1, services: [new Foo()] };
 *   };
 *
 * Everything a plugin needs at runtime comes from the sdk, so a bare
 * `git clone` into the plugins directory is a complete installation.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LatchkeySdk } from './pluginSdk.js';
import { Service } from './services/core/base.js';

/**
 * The version of the contract between Latchkey and plugins. Plugins declare
 * the version they were written against; a mismatch is refused at load time
 * rather than failing in some subtler way later.
 */
export const PLUGIN_API_VERSION = 1;

export interface LatchkeyPlugin {
  readonly apiVersion: typeof PLUGIN_API_VERSION;
  readonly services: readonly Service[];
}

export type LatchkeyPluginFactory = (sdk: LatchkeySdk) => LatchkeyPlugin | Promise<LatchkeyPlugin>;

export interface LoadedPlugin {
  /** The name of the plugin's directory inside the plugins directory. */
  readonly name: string;
  readonly directory: string;
  readonly services: readonly Service[];
}

export class PluginLoadError extends Error {
  constructor(pluginName: string, detail: string) {
    super(`Failed to load plugin '${pluginName}': ${detail}`);
    this.name = 'PluginLoadError';
  }
}

const PACKAGE_JSON_FILENAME = 'package.json';
const DEFAULT_ENTRY_FILENAME = 'index.js';

// ─── Loading ──────────────────────────────────────────────────────────────────

/**
 * The entry a package.json `exports` field points at for the package root,
 * or undefined when it names none that an `import` would pick.
 */
function pickEntryFromExports(exportsField: unknown): string | undefined {
  if (typeof exportsField === 'string') {
    return exportsField;
  }
  if (typeof exportsField !== 'object' || exportsField === null) {
    return undefined;
  }
  const record = exportsField as Readonly<Record<string, unknown>>;
  if ('.' in record) {
    return pickEntryFromExports(record['.']);
  }
  return pickEntryFromExports(record.import ?? record.default);
}

function resolvePluginEntryFile(pluginName: string, pluginDirectory: string): string {
  const packageJsonPath = join(pluginDirectory, PACKAGE_JSON_FILENAME);
  let entry = DEFAULT_ENTRY_FILENAME;
  if (existsSync(packageJsonPath)) {
    let packageJson: unknown;
    try {
      packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new PluginLoadError(pluginName, `invalid ${PACKAGE_JSON_FILENAME}: ${message}`);
    }
    const { exports: exportsField, main } = packageJson as {
      readonly exports?: unknown;
      readonly main?: unknown;
    };
    entry = pickEntryFromExports(exportsField) ?? (typeof main === 'string' ? main : entry);
  }
  const entryFile = join(pluginDirectory, entry);
  if (!existsSync(entryFile)) {
    throw new PluginLoadError(
      pluginName,
      `entry file '${entryFile}' does not exist. ` +
        'If the plugin is written in TypeScript, it has to be built first.'
    );
  }
  return entryFile;
}

function validatePluginManifest(pluginName: string, manifest: unknown): LatchkeyPlugin {
  if (typeof manifest !== 'object' || manifest === null) {
    throw new PluginLoadError(pluginName, 'the plugin factory did not return an object.');
  }
  const { apiVersion, services } = manifest as {
    readonly apiVersion?: unknown;
    readonly services?: unknown;
  };
  if (apiVersion !== PLUGIN_API_VERSION) {
    throw new PluginLoadError(
      pluginName,
      `it declares plugin API version ${String(apiVersion)}, ` +
        `but this Latchkey provides version ${String(PLUGIN_API_VERSION)}.`
    );
  }
  if (!Array.isArray(services)) {
    throw new PluginLoadError(pluginName, "'services' must be an array of Service instances.");
  }
  for (const service of services as readonly unknown[]) {
    if (!(service instanceof Service)) {
      throw new PluginLoadError(
        pluginName,
        "every entry of 'services' must extend the Service class handed to the plugin " +
          'as sdk.Service. A service that looks right but is still refused usually extends ' +
          'the class of a separately installed latchkey instead.'
      );
    }
  }
  return { apiVersion: PLUGIN_API_VERSION, services: services as readonly Service[] };
}

async function loadPlugin(
  pluginName: string,
  pluginDirectory: string,
  sdk: LatchkeySdk
): Promise<LoadedPlugin> {
  const entryFile = resolvePluginEntryFile(pluginName, pluginDirectory);
  let importedModule: unknown;
  try {
    importedModule = (await import(pathToFileURL(entryFile).href)) as unknown;
  } catch (error) {
    throw new PluginLoadError(
      pluginName,
      `could not import '${entryFile}': ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const factory = (importedModule as { readonly default?: unknown }).default;
  if (typeof factory !== 'function') {
    throw new PluginLoadError(
      pluginName,
      `'${entryFile}' must have a default export that is a function (sdk) => plugin.`
    );
  }
  let manifest: unknown;
  try {
    manifest = await (factory as (sdk: LatchkeySdk) => unknown)(sdk);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PluginLoadError(pluginName, `the plugin factory threw: ${message}`);
  }
  const { services } = validatePluginManifest(pluginName, manifest);
  return { name: pluginName, directory: pluginDirectory, services };
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/**
 * Load every plugin found in `directory`, in alphabetical order of directory
 * name. Entries that are not directories (following symlinks, so a checkout
 * elsewhere can be linked in) are ignored, as are `node_modules` and dot
 * directories. A missing directory means no plugins. Throws `PluginLoadError`
 * on the first plugin that cannot be loaded.
 */
export async function loadPlugins(
  directory: string,
  sdk: LatchkeySdk
): Promise<readonly LoadedPlugin[]> {
  if (!isDirectory(directory)) {
    return [];
  }
  const pluginNames = readdirSync(directory)
    .filter((name) => !name.startsWith('.') && name !== 'node_modules')
    .filter((name) => isDirectory(join(directory, name)))
    .sort();

  const plugins: LoadedPlugin[] = [];
  for (const pluginName of pluginNames) {
    plugins.push(await loadPlugin(pluginName, join(directory, pluginName), sdk));
  }
  return plugins;
}

/**
 * The built-in services followed by every plugin's, refusing a plugin service
 * whose name is already taken. The registry itself only checks names as
 * services are added one by one, and these all go in together.
 */
export function combineWithPluginServices(
  builtinServices: readonly Service[],
  plugins: readonly LoadedPlugin[]
): readonly Service[] {
  const providers = new Map<string, string>(
    builtinServices.map((service) => [service.name, 'Latchkey itself'])
  );
  for (const plugin of plugins) {
    for (const service of plugin.services) {
      const provider = providers.get(service.name);
      if (provider !== undefined) {
        throw new PluginLoadError(
          plugin.name,
          `service '${service.name}' is already provided by ${provider}.`
        );
      }
      providers.set(service.name, `plugin '${plugin.name}'`);
    }
  }
  return [...builtinServices, ...plugins.flatMap((plugin) => plugin.services)];
}
