/**
 * The package as a program that depends on it gets it: packed with `npm pack`,
 * unpacked into the `node_modules` of an empty project, and used from there
 * through `latchkey/embed`. Nothing here reaches the network.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');

/**
 * The values `latchkey/embed` exports. The entry point is a public interface:
 * a name that is renamed or removed has to fail here, and one that is added
 * has to be added here, where the consumer program below then uses it.
 */
const EMBED_VALUE_NAMES: readonly string[] = [
  'AccountNotFoundError',
  'AccountNotStoredError',
  'AmbiguousAccountError',
  'ApiCredentialStore',
  'ApiCredentialStoreError',
  'BrowserStateNotFoundError',
  'Config',
  'CurlCommandConflictError',
  'CurlNotFoundError',
  'DecryptionError',
  'DestinationCredentialsUnreadableError',
  'DestinationDataFormatError',
  'DestinationNotADirectoryError',
  'EncryptedStorage',
  'EncryptedStorageError',
  'EncryptionError',
  'ExtensionLoadError',
  'ExtensionStartError',
  'GATEWAY_ACCOUNT_HEADER',
  'GATEWAY_INTERNAL_HEADERS',
  'GATEWAY_NO_CREDENTIALS_HEADER',
  'GATEWAY_PASSWORD_HEADER',
  'HOP_BY_HOP_HEADERS',
  'InsecureFilePermissionsError',
  'InvalidDestinationKeyError',
  'InvalidPermissionsOverrideError',
  'InvalidRuntimeDirectoryError',
  'MigrationError',
  'NothingToReencryptError',
  'PERMISSIONS_OVERRIDE_HEADER',
  'PermissionCheckError',
  'PermissionsOverrideFileMissingError',
  'PluginLoadError',
  'ReencryptCredentialsError',
  'ServiceRegistry',
  'ServicesNotStoredError',
  'SourceCredentialsUnreadableError',
  'UnknownRuntimeError',
  'UnknownServiceError',
  'authList',
  'clearCredentials',
  'createGatewayRequestHandler',
  'createLatchkeyRuntime',
  'createPermissionsOverrideJwt',
  'decrypt',
  'derivePermissionsOverrideSigningKey',
  'encrypt',
  'generateKey',
  'ignoreInspectorSignal',
  'loadExtensions',
  'reencryptCredentials',
  'servicesInfo',
  'servicesList',
  'startGateway',
  'verifyPermissionsOverrideJwt',
];

/** The types `latchkey/embed` exports, held to the same rule as the values. */
const EMBED_TYPE_NAMES: readonly string[] = [
  'AccountCredentialStatuses',
  'ApiCredentials',
  'ApiCredentialsType',
  'CredentialStatusEntry',
  'CredentialsLocation',
  'CredentialsSelection',
  'ExtensionContext',
  'ExtensionHandler',
  'ExtensionLifecycleHook',
  'GatewayExtension',
  'GatewayRequestHandler',
  'GatewayRequestHandlerOptions',
  'GatewayServer',
  'GatewayServerOptions',
  'LatchkeyRuntime',
  'LatchkeyRuntimeOptions',
  'LatchkeyRuntimeSettings',
  'PermissionCheckMetadata',
  'ReencryptCredentialsOptions',
  'ReencryptCredentialsResult',
  'Service',
  'ServiceCapabilities',
  'ServicesInfoResult',
];

/**
 * A program that uses every export of `latchkey/embed`, to be type-checked
 * against the declarations of the packed package.
 */
const CONSUMER_SOURCE = `
import * as http from 'node:http';
import {
  ${EMBED_VALUE_NAMES.join(',\n  ')},
} from 'latchkey/embed';
import type {
  ${EMBED_TYPE_NAMES.join(',\n  ')},
} from 'latchkey/embed';

export const everyValue = {
  ${EMBED_VALUE_NAMES.join(',\n  ')},
};

export type EveryType = [
  ${EMBED_TYPE_NAMES.join(',\n  ')},
];

export async function embedLatchkey(directory: string, encryptionKey: string): Promise<void> {
  ignoreInspectorSignal();

  const settings: LatchkeyRuntimeSettings = { passthroughUnknown: true, hideBuiltinServices: [] };
  const runtimeOptions: LatchkeyRuntimeOptions = {
    directory,
    encryptionKey,
    settings,
    log: (message: string) => void message,
    errorLog: (message: string) => void message,
  };
  const runtime: LatchkeyRuntime = await createLatchkeyRuntime(runtimeOptions);
  const config: Config = runtime.config;
  const store: ApiCredentialStore = runtime.apiCredentialStore;
  const storage: EncryptedStorage = runtime.encryptedStorage;
  const registry: ServiceRegistry = runtime.createServiceRegistry();
  const services: readonly Service[] = runtime.baseServices;
  const credentialsTypes: readonly ApiCredentialsType[] = runtime.apiCredentialsTypes;
  const credentials: ApiCredentials | null = store.get('slack');
  const version: string = runtime.version;

  const start: ExtensionLifecycleHook = () => undefined;
  const handleAccounts: ExtensionHandler = (request, response, context: ExtensionContext) => {
    if (request.url !== '/extensions/accounts') return false;
    response.writeHead(200, { 'X-Permissions-Config': context.permissionsConfigPath });
    response.end(JSON.stringify(store.listAccounts('slack')));
    return true;
  };
  const accounts: GatewayExtension = { name: 'accounts', handler: handleAccounts, start };
  const metadata: PermissionCheckMetadata = { account: '', workspace: 'workspace-7' };
  const handlerOptions: GatewayRequestHandlerOptions = {
    password: null,
    maxBodySize: 1024 * 1024,
    extensions: [accounts, ...(await loadExtensions(config.extensionsDirectoryPath))],
    defaultPermissionCheckMetadata: metadata,
  };
  const handler: GatewayRequestHandler = createGatewayRequestHandler(runtime, handlerOptions);
  await handler.start();
  const server: http.Server = http.createServer(handler.handleRequest);
  server.close();
  const stopped: void = await handler.stop({ deadlineMilliseconds: 1_000 });

  const serverOptions: GatewayServerOptions = { ...handlerOptions, host: '127.0.0.1', port: 0 };
  const gateway: GatewayServer = await startGateway(runtime, serverOptions);
  const listening: http.Server = gateway.server;
  await gateway.close();

  const selection: CredentialsSelection = { kind: 'account', account: 'work@example.com' };
  const isCleared: boolean = clearCredentials(runtime, 'slack', selection);
  const location: CredentialsLocation = { directory, encryptionKey };
  const reencryptOptions: ReencryptCredentialsOptions = {
    source: location,
    destination: location,
    apiCredentialsTypes: credentialsTypes,
    services: ['slack'],
    account: 'work@example.com',
    isBrowserStateIncluded: false,
  };
  let result: ReencryptCredentialsResult | null = null;
  try {
    result = await reencryptCredentials(reencryptOptions);
  } catch (error) {
    if (!(error instanceof ReencryptCredentialsError)) throw error;
    const hint: string | null = error.hint;
    void hint;
  }
  const browserStatePath: string | null = result === null ? null : result.browserStatePath;

  const names: readonly string[] = servicesList(registry, store, config, { builtin: true });
  const information: ServicesInfoResult = await servicesInfo(registry, store, config, 'slack', true);
  const capabilities: ServiceCapabilities = information.capabilities;
  const statuses: Record<string, AccountCredentialStatuses> = await authList(registry, store, config, true);
  const entries: readonly CredentialStatusEntry[] = Object.values(statuses).flatMap((accountStatuses) =>
    Object.values(accountStatuses)
  );

  const signingKey: Buffer = derivePermissionsOverrideSigningKey(encryptionKey);
  const token: string = createPermissionsOverrideJwt(config.permissionsConfigPath, signingKey);
  const claims: { readonly permissionsConfig: string } = verifyPermissionsOverrideJwt(token, signingKey);
  const headerNames: readonly string[] = [
    GATEWAY_ACCOUNT_HEADER,
    GATEWAY_NO_CREDENTIALS_HEADER,
    GATEWAY_PASSWORD_HEADER,
    PERMISSIONS_OVERRIDE_HEADER,
  ];
  const isInternal: boolean = GATEWAY_INTERNAL_HEADERS.has(GATEWAY_PASSWORD_HEADER);
  const isHopByHop: boolean = HOP_BY_HOP_HEADERS.has('connection');
  const plaintext: string = decrypt(encrypt('text', generateKey()), encryptionKey);

  void [storage, services, credentials, version, stopped, listening, isCleared, browserStatePath];
  void [names, capabilities, entries, claims, headerNames, isInternal, isHopByHop, plaintext];
}

// The directives below fail the type check unless the lines under them are
// errors, which they are only when the declarations of the package are seen.
// @ts-expect-error -- a runtime cannot be described without its directory
export const incompleteOptions: LatchkeyRuntimeOptions = { encryptionKey: '', log: () => undefined, errorLog: () => undefined };
// @ts-expect-error -- stopping takes a deadline
export const stopWithoutDeadline = (handler: GatewayRequestHandler): Promise<void> => handler.stop({});
`;

const CONSUMER_TYPESCRIPT_CONFIGURATION = {
  compilerOptions: {
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    target: 'ES2022',
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  },
  files: ['consumer.ts'],
};

const LIST_EXPORTS_SCRIPT = `
console.log(JSON.stringify(Object.keys(await import('latchkey/embed'))));
`;

const SERVE_HEALTH_SCRIPT = `
import * as http from 'node:http';
import { createGatewayRequestHandler, createLatchkeyRuntime, generateKey } from 'latchkey/embed';

const runtime = await createLatchkeyRuntime({
  directory: process.argv[2],
  encryptionKey: generateKey(),
  log: () => undefined,
  errorLog: () => undefined,
});
const handler = createGatewayRequestHandler(runtime, {
  password: null,
  maxBodySize: 1024 * 1024,
  extensions: [],
});
await handler.start();
const server = http.createServer(handler.handleRequest);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const response = await fetch(\`http://127.0.0.1:\${server.address().port}/\`);
const health = await response.json();
server.close();
server.closeAllConnections();
await handler.stop({ deadlineMilliseconds: 1_000 });
console.log(JSON.stringify({ statusCode: response.status, health }));
`;

const IMPORT_ENTRY_SCRIPT = `
const report = { isImported: false, errorName: null };
try {
  await import(process.argv[2]);
  report.isImported = true;
} catch (error) {
  report.errorName = error.name;
}
report.descriptorVariable = process.env.LATCHKEY_ENV_OVERRIDES_FD ?? null;
console.log(JSON.stringify(report));
`;

/**
 * The names an entry point's source exports as types: those of an
 * `export type { ... }` statement, and those marked `type` in an
 * `export { ... }` statement.
 */
function exportedTypeNames(entrySource: string): readonly string[] {
  const names: string[] = [];
  for (const statement of entrySource.matchAll(/export\s+(type\s+)?\{([^}]*)\}/g)) {
    const isTypeOnlyStatement = statement[1] !== undefined;
    const specifiers = statement[2]!
      .split(',')
      .map((specifier) => specifier.trim())
      .filter((specifier) => specifier !== '');
    for (const specifier of specifiers) {
      if (isTypeOnlyStatement || specifier.startsWith('type ')) {
        names.push(specifier.replace(/^type\s+/, ''));
      }
    }
  }
  return names.sort();
}

interface PackedPackageManifest {
  readonly version: string;
  readonly exports: Readonly<Record<string, unknown>>;
}

describe('the packed package, for a program that embeds it', () => {
  let temporaryDirectory: string;
  let packageDirectory: string;
  let consumerDirectory: string;
  let packedManifest: PackedPackageManifest;

  // npm is kept off the network, and quiet about itself.
  const npmEnvironment = {
    ...process.env,
    npm_config_offline: 'true',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  };

  function runNpm(npmArguments: readonly string[], workingDirectory: string): void {
    execFileSync('npm', npmArguments, {
      cwd: workingDirectory,
      env: npmEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
      // npm is a command script on Windows, which only a shell runs.
      shell: process.platform === 'win32',
    });
  }

  /** Run a script of the consumer project with plain node, and parse the line it prints. */
  function runConsumerScript(
    scriptName: string,
    scriptArguments: readonly string[],
    environment: NodeJS.ProcessEnv = process.env
  ): unknown {
    const output = execFileSync(process.execPath, [scriptName, ...scriptArguments], {
      cwd: consumerDirectory,
      env: environment,
      stdio: ['ignore', 'pipe', 'inherit'],
      encoding: 'utf-8',
      timeout: 60_000,
    });
    return JSON.parse(output);
  }

  beforeAll(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'latchkey-consumer-test-'));

    // Build and pack a copy of the package, with the package's own commands.
    // A copy, because the build writes `dist` and `src/version.ts`, which the
    // tests running beside this one read from the checkout.
    const stagingDirectory = join(temporaryDirectory, 'staging');
    mkdirSync(stagingDirectory);
    for (const name of ['package.json', 'tsconfig.json', 'README.md', 'LICENSE']) {
      cpSync(join(projectRoot, name), join(stagingDirectory, name));
    }
    for (const name of ['src', 'tests', 'scripts', 'skills']) {
      cpSync(join(projectRoot, name), join(stagingDirectory, name), { recursive: true });
    }
    symlinkSync(
      join(projectRoot, 'node_modules'),
      join(stagingDirectory, 'node_modules'),
      'junction'
    );
    const archiveDirectory = join(temporaryDirectory, 'archive');
    mkdirSync(archiveDirectory);
    runNpm(['run', 'build'], stagingDirectory);
    runNpm(['pack', '--pack-destination', archiveDirectory], stagingDirectory);
    const archiveNames = readdirSync(archiveDirectory);
    expect(archiveNames).toHaveLength(1);

    // Install the archive into an empty project, by hand: its dependencies are
    // those the checkout already has, so nothing has to be downloaded.
    consumerDirectory = join(temporaryDirectory, 'project');
    packageDirectory = join(consumerDirectory, 'node_modules', 'latchkey');
    const unpackDirectory = join(temporaryDirectory, 'unpacked');
    mkdirSync(unpackDirectory);
    mkdirSync(join(consumerDirectory, 'node_modules', '@types'), { recursive: true });
    execFileSync('tar', ['-xzf', join(archiveDirectory, archiveNames[0]!), '-C', unpackDirectory]);
    renameSync(join(unpackDirectory, 'package'), packageDirectory);
    symlinkSync(
      join(projectRoot, 'node_modules'),
      join(packageDirectory, 'node_modules'),
      'junction'
    );
    // The types of Node.js are a dependency of the consumer's own.
    symlinkSync(
      join(projectRoot, 'node_modules', '@types', 'node'),
      join(consumerDirectory, 'node_modules', '@types', 'node'),
      'junction'
    );
    packedManifest = JSON.parse(
      readFileSync(join(packageDirectory, 'package.json'), 'utf-8')
    ) as PackedPackageManifest;

    const consumerFiles: Readonly<Record<string, string>> = {
      'package.json': JSON.stringify({ name: 'latchkey-consumer', private: true, type: 'module' }),
      'tsconfig.json': JSON.stringify(CONSUMER_TYPESCRIPT_CONFIGURATION),
      'consumer.ts': CONSUMER_SOURCE,
      'list-exports.mjs': LIST_EXPORTS_SCRIPT,
      'serve-health.mjs': SERVE_HEALTH_SCRIPT,
      'import-entry.mjs': IMPORT_ENTRY_SCRIPT,
    };
    for (const [fileName, content] of Object.entries(consumerFiles)) {
      writeFileSync(join(consumerDirectory, fileName), content, 'utf-8');
    }
  }, 180_000);

  afterAll(() => {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('pins every export of the source entry point', async () => {
    const sourceEntry = (await import('../src/embed.js')) as Readonly<Record<string, unknown>>;

    expect(Object.keys(sourceEntry).sort()).toEqual([...EMBED_VALUE_NAMES].sort());
    expect(exportedTypeNames(readFileSync(join(projectRoot, 'src', 'embed.ts'), 'utf-8'))).toEqual(
      [...EMBED_TYPE_NAMES].sort()
    );
  });

  it('names latchkey/embed in the exports of its package.json, with files that are in the archive', () => {
    const embedExport = packedManifest.exports['./embed'] as {
      readonly types?: unknown;
      readonly default?: unknown;
    };

    expect(typeof embedExport.types).toBe('string');
    expect(typeof embedExport.default).toBe('string');
    expect(existsSync(join(packageDirectory, embedExport.types as string))).toBe(true);
    expect(existsSync(join(packageDirectory, embedExport.default as string))).toBe(true);
  });

  it('exports from latchkey/embed the values the source entry point exports', () => {
    const packedNames = runConsumerScript('list-exports.mjs', []) as readonly string[];

    expect([...packedNames].sort()).toEqual([...EMBED_VALUE_NAMES].sort());
  });

  it('type-checks a program that uses every export of latchkey/embed', () => {
    const typeCheck = spawnSync(
      process.execPath,
      [join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '--project', '.'],
      { cwd: consumerDirectory, encoding: 'utf-8' }
    );

    expect({ output: typeCheck.stdout + typeCheck.stderr, status: typeCheck.status }).toEqual({
      output: '',
      status: 0,
    });
  }, 60_000);

  it('serves the health of a gateway from a script that plain node runs', () => {
    const report = runConsumerScript('serve-health.mjs', [join(temporaryDirectory, 'latchkey')]);

    expect(report).toEqual({
      statusCode: 200,
      health: { status: 'ok', version: packedManifest.version },
    });
  }, 60_000);

  it('is imported through latchkey/embed in an environment that the main entry point fails in', () => {
    const homeDirectory = join(temporaryDirectory, 'home');
    mkdirSync(homeDirectory);
    const environment = {
      ...process.env,
      LATCHKEY_ENV_OVERRIDES_FD: 'not-a-number',
      LATCHKEY_DIRECTORY: join(temporaryDirectory, 'does-not-exist'),
      HOME: homeDirectory,
      USERPROFILE: homeDirectory,
    };

    const embedReport = runConsumerScript('import-entry.mjs', ['latchkey/embed'], environment);
    const mainReport = runConsumerScript('import-entry.mjs', ['latchkey'], environment);

    expect(embedReport).toEqual({
      isImported: true,
      errorName: null,
      descriptorVariable: 'not-a-number',
    });
    expect(readdirSync(homeDirectory)).toEqual([]);
    expect(mainReport).toEqual({
      isImported: false,
      errorName: 'InvalidEnvironmentOverridesError',
      descriptorVariable: null,
    });
  }, 60_000);
});
