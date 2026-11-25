import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ApiCredentialStore,
  Config,
  createGatewayRequestHandler,
  createLatchkeyRuntime,
  createPermissionsOverrideJwt,
  derivePermissionsOverrideSigningKey,
  EncryptedStorage,
  ExtensionStartError,
  GATEWAY_PASSWORD_HEADER,
  generateKey,
  loadExtensions,
  PERMISSIONS_OVERRIDE_HEADER,
  startGateway,
  verifyPermissionsOverrideJwt,
  type ExtensionContext,
  type GatewayExtension,
  type GatewayRequestHandler,
  type GatewayRequestHandlerOptions,
  type GatewayServer,
  type LatchkeyRuntime,
  type PermissionCheckMetadata,
} from '../src/embed.js';
import { BUILTIN_API_CREDENTIALS_TYPES } from '../src/apiCredentials/serialization.js';
import { resetCurlCommand, type AsyncCurlResult } from '../src/curl.js';
import { assembleLatchkeyRuntime, resetClaimedCurlCommand } from '../src/runtime.js';
import { serve, StandInFailure, type TestServer } from './embedTestSupport.js';
import { createMockService } from './mockService.js';

const STORED_ACCOUNT = 'work@example.com';
const RUNTIME_VERSION = '0.0.0-test';
const MAXIMUM_BODY_SIZE = 10 * 1024 * 1024;

interface RecordedPermissionCheck {
  readonly url: string;
  readonly configPath: string;
  readonly metadata: PermissionCheckMetadata | undefined;
}

interface ErrorBody {
  readonly error: string;
  readonly latchkeyError: boolean;
}

describe('createGatewayRequestHandler', () => {
  let temporaryDirectory: string;
  let directory: string;
  let servers: TestServer[];
  let gateways: GatewayServer[];
  let permissionChecks: RecordedPermissionCheck[];
  let isPermitted: boolean;
  let curlInvocations: (readonly string[])[];
  let events: string[];

  /**
   * A runtime over the test's directory whose curl runner and permission
   * check are stand-ins, with one stored Slack account.
   */
  function assembleStandInRuntime(
    fileSettings: { readonly passthroughUnknown?: boolean } = {}
  ): LatchkeyRuntime {
    const encryptionKey = generateKey();
    const config = new Config(
      (name) => (name === 'LATCHKEY_DIRECTORY' ? directory : undefined),
      () => fileSettings
    );
    const encryptedStorage = new EncryptedStorage(encryptionKey);
    encryptedStorage.writeFile(
      config.credentialStorePath,
      JSON.stringify({
        credentials: {
          slack: {
            [STORED_ACCOUNT]: {
              objectType: 'rawCurl',
              curlArguments: ['-H', 'Authorization: Bearer test-token'],
            },
          },
        },
      })
    );
    return assembleLatchkeyRuntime({
      config,
      encryptedStorage,
      apiCredentialStore: new ApiCredentialStore(config.credentialStorePath, encryptedStorage),
      baseServices: [createMockService()],
      apiCredentialsTypes: BUILTIN_API_CREDENTIALS_TYPES,
      permissionsOverrideSigningKey: derivePermissionsOverrideSigningKey(encryptionKey),
      runCurlAsync: (curlArguments: readonly string[]): Promise<AsyncCurlResult> => {
        curlInvocations.push(curlArguments);
        const headerFilePath = curlArguments[curlArguments.indexOf('-D') + 1]!;
        writeFileSync(headerFilePath, 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n');
        return Promise.resolve({ returncode: 0, stdout: Buffer.from('{"ok":true}'), stderr: '' });
      },
      checkPermission: (request, configPath, _doNotUseBuiltinSchemas, metadata) => {
        events.push('permission check');
        permissionChecks.push({ url: request.url, configPath, metadata });
        return Promise.resolve(isPermitted);
      },
      log: () => undefined,
      errorLog: () => undefined,
      version: RUNTIME_VERSION,
    });
  }

  function handlerOptions(
    overrides: Partial<GatewayRequestHandlerOptions> = {}
  ): GatewayRequestHandlerOptions {
    return { password: null, maxBodySize: MAXIMUM_BODY_SIZE, extensions: [], ...overrides };
  }

  /** Attach a handler to a server the test creates, as an embedding program does. */
  async function serveHandler(
    runtime: LatchkeyRuntime,
    overrides: Partial<GatewayRequestHandlerOptions> = {}
  ): Promise<{ readonly handler: GatewayRequestHandler; readonly baseUrl: string }> {
    const handler = createGatewayRequestHandler(runtime, handlerOptions(overrides));
    await handler.start();
    const server = await serve(handler.handleRequest);
    servers.push(server);
    return { handler, baseUrl: server.baseUrl };
  }

  /** An extension that answers one path with a fixed text. */
  function fixedAnswerExtension(path: string, answer: string): GatewayExtension {
    return {
      name: `fixed answer for ${path}`,
      handler: (request, response) => {
        if (request.url !== path) return false;
        events.push(`extension ${path}`);
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.end(answer);
        return true;
      },
    };
  }

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'latchkey-handler-test-'));
    directory = join(temporaryDirectory, 'latchkey');
    servers = [];
    gateways = [];
    permissionChecks = [];
    isPermitted = true;
    curlInvocations = [];
    events = [];
  });

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    await Promise.all(gateways.map((gateway) => gateway.close()));
    resetClaimedCurlCommand();
    resetCurlCommand();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  describe('the paths of a request', () => {
    it.each([
      ['GET', '/'],
      ['POST', '/latchkey/'],
      ['GET', '/gateway/https://slack.com/api/auth.test'],
      ['GET', '/extensions/hello'],
    ])('refuses %s %s without the password when one is set', async (method, path) => {
      const { baseUrl } = await serveHandler(assembleStandInRuntime(), {
        password: 'sekret',
        extensions: [fixedAnswerExtension('/extensions/hello', 'hello')],
      });

      const withoutPassword = await fetch(`${baseUrl}${path}`, { method });
      const withWrongPassword = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { [GATEWAY_PASSWORD_HEADER]: 'guess' },
      });

      for (const response of [withoutPassword, withWrongPassword]) {
        expect(response.status).toBe(401);
        expect(((await response.json()) as ErrorBody).latchkeyError).toBe(true);
      }
      expect(events).toEqual([]);
      expect(curlInvocations).toEqual([]);
    });

    it('answers GET / with the health of the gateway, given the password', async () => {
      const { baseUrl } = await serveHandler(assembleStandInRuntime(), { password: 'sekret' });

      const response = await fetch(`${baseUrl}/`, {
        headers: { [GATEWAY_PASSWORD_HEADER]: 'sekret' },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok', version: RUNTIME_VERSION });
    });

    it('runs a command posted to /latchkey/ against the runtime', async () => {
      const { baseUrl } = await serveHandler(assembleStandInRuntime());

      const response = await fetch(`${baseUrl}/latchkey/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'services list' }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ result: ['slack'] });
    });

    it('proxies /gateway/<url> through curl with the stored credentials', async () => {
      const { baseUrl } = await serveHandler(assembleStandInRuntime());

      const response = await fetch(`${baseUrl}/gateway/https://slack.com/api/auth.test`);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(await response.text()).toBe('{"ok":true}');
      expect(curlInvocations).toHaveLength(1);
      expect(curlInvocations[0]).toContain('Authorization: Bearer test-token');
      expect(curlInvocations[0]!.at(-1)).toBe('https://slack.com/api/auth.test');
    });

    it('offers a request that is not its own to the extensions', async () => {
      const { baseUrl } = await serveHandler(assembleStandInRuntime(), {
        extensions: [fixedAnswerExtension('/extensions/hello', 'hello from an extension')],
      });

      const response = await fetch(`${baseUrl}/extensions/hello`);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('hello from an extension');
    });

    it('answers 404 for a path that nothing claims', async () => {
      const withoutExtensions = await serveHandler(assembleStandInRuntime());
      const withAnExtension = await serveHandler(assembleStandInRuntime(), {
        extensions: [fixedAnswerExtension('/extensions/hello', 'hello')],
      });

      const responses = [
        await fetch(`${withoutExtensions.baseUrl}/extensions/hello`),
        await fetch(`${withAnExtension.baseUrl}/extensions/other`),
      ];

      for (const response of responses) {
        expect(response.status).toBe(404);
        expect(await response.text()).toBe('');
      }
    });
  });

  describe('an extension passed as a value', () => {
    let runtime: LatchkeyRuntime;
    let receivedContexts: ExtensionContext[];
    let baseUrl: string;

    beforeEach(async () => {
      runtime = assembleStandInRuntime();
      receivedContexts = [];
      const accounts: GatewayExtension = {
        name: 'accounts',
        handler: (request, response, context) => {
          if (request.url !== '/extensions/accounts') return false;
          events.push('extension');
          receivedContexts.push(context);
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(runtime.apiCredentialStore.listAccounts('slack')));
          return true;
        },
      };
      ({ baseUrl } = await serveHandler(runtime, { password: 'sekret', extensions: [accounts] }));
    });

    it('is not offered a request that fails the password check', async () => {
      const response = await fetch(`${baseUrl}/extensions/accounts`);

      expect(response.status).toBe(401);
      expect(events).toEqual([]);
    });

    it('is not offered a request that the permission check refuses', async () => {
      isPermitted = false;

      const response = await fetch(`${baseUrl}/extensions/accounts`, {
        headers: { [GATEWAY_PASSWORD_HEADER]: 'sekret' },
      });

      expect(response.status).toBe(403);
      expect(((await response.json()) as ErrorBody).latchkeyError).toBe(true);
      expect(events).toEqual(['permission check']);
    });

    it('is offered a request after both checks, with the context, and reads the store of its runtime', async () => {
      const response = await fetch(`${baseUrl}/extensions/accounts`, {
        headers: { [GATEWAY_PASSWORD_HEADER]: 'sekret' },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([STORED_ACCOUNT]);
      expect(events).toEqual(['permission check', 'extension']);
      expect(permissionChecks.map((check) => check.url)).toEqual([
        'https://latchkey-self.invalid:1/extensions/accounts',
      ]);
      expect(permissionChecks[0]!.configPath).toBe(join(directory, 'permissions.json'));
      expect(receivedContexts).toEqual([
        { permissionsConfigPath: join(directory, 'permissions.json') },
      ]);
      expect(Object.isFrozen(receivedContexts[0])).toBe(true);
    });
  });

  describe('the extensions folder of the directory', () => {
    let runtime: LatchkeyRuntime;
    let markerPath: string;

    beforeEach(() => {
      runtime = assembleStandInRuntime();
      markerPath = join(temporaryDirectory, 'extension-file-was-imported');
      mkdirSync(runtime.config.extensionsDirectoryPath, { recursive: true });
      writeFileSync(
        join(runtime.config.extensionsDirectoryPath, 'from-file.mjs'),
        `import { writeFileSync } from 'node:fs';
         writeFileSync(${JSON.stringify(markerPath)}, 'imported');
         export default (request, response) => {
           if (request.url !== '/extensions/from-file') return false;
           response.writeHead(200, { 'Content-Type': 'text/plain' });
           response.end('from a file');
           return true;
         };`,
        'utf-8'
      );
    });

    it('is not loaded by createGatewayRequestHandler', async () => {
      const { baseUrl } = await serveHandler(runtime);

      const response = await fetch(`${baseUrl}/extensions/from-file`);

      expect(response.status).toBe(404);
      expect(existsSync(markerPath)).toBe(false);
    });

    it('is not loaded by startGateway', async () => {
      const gateway = await startGateway(runtime, {
        ...handlerOptions(),
        host: '127.0.0.1',
        port: 0,
      });
      gateways.push(gateway);
      const address = gateway.server.address();
      const port = address !== null && typeof address !== 'string' ? address.port : 0;

      const response = await fetch(`http://127.0.0.1:${String(port)}/extensions/from-file`);

      expect(response.status).toBe(404);
      expect(existsSync(markerPath)).toBe(false);
    });

    it('is served when its extensions are loaded with loadExtensions and passed', async () => {
      const extensions = await loadExtensions(runtime.config.extensionsDirectoryPath);
      const { baseUrl } = await serveHandler(runtime, { extensions });

      const response = await fetch(`${baseUrl}/extensions/from-file`);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('from a file');
      expect(existsSync(markerPath)).toBe(true);
    });
  });

  describe('the metadata of a permission check', () => {
    const DEFAULT_METADATA = { workspace: 'workspace-7' };

    it('is that of the caller for a request offered to the extensions, when the caller gave some', async () => {
      const { baseUrl } = await serveHandler(assembleStandInRuntime(), {
        extensions: [fixedAnswerExtension('/extensions/hello', 'hello')],
        defaultPermissionCheckMetadata: DEFAULT_METADATA,
      });

      await fetch(`${baseUrl}/extensions/hello`);

      expect(permissionChecks.map((check) => check.metadata)).toEqual([DEFAULT_METADATA]);
    });

    it('is absent for a request offered to the extensions, when the caller gave none', async () => {
      const { baseUrl } = await serveHandler(assembleStandInRuntime(), {
        extensions: [fixedAnswerExtension('/extensions/hello', 'hello')],
      });

      await fetch(`${baseUrl}/extensions/hello`);

      expect(permissionChecks).toHaveLength(1);
      expect(permissionChecks[0]!.metadata).toBeUndefined();
    });

    it.each([
      ['the caller gave some', DEFAULT_METADATA],
      ['the caller gave none', undefined],
    ])(
      'is the account for a proxied request that injects credentials, when %s',
      async (_description, defaultPermissionCheckMetadata) => {
        const { baseUrl } = await serveHandler(assembleStandInRuntime(), {
          defaultPermissionCheckMetadata,
        });

        const response = await fetch(`${baseUrl}/gateway/https://slack.com/api/auth.test`);

        expect(response.status).toBe(200);
        expect(permissionChecks.map((check) => check.metadata)).toEqual([
          { account: STORED_ACCOUNT },
        ]);
      }
    );

    it.each([
      ['that of the caller when the caller gave some', DEFAULT_METADATA, DEFAULT_METADATA],
      ['absent when the caller gave none', undefined, undefined],
    ])(
      'is %s, for a proxied request that injects nothing',
      async (_description, defaultPermissionCheckMetadata, expectedMetadata) => {
        const { baseUrl } = await serveHandler(
          assembleStandInRuntime({ passthroughUnknown: true }),
          { defaultPermissionCheckMetadata }
        );

        const response = await fetch(`${baseUrl}/gateway/https://unknown.example.com/anything`);

        expect(response.status).toBe(200);
        expect(curlInvocations[0]).not.toContain('Authorization: Bearer test-token');
        expect(permissionChecks).toHaveLength(1);
        expect(permissionChecks[0]!.metadata).toEqual(expectedMetadata);
      }
    );
  });

  it('serves different extensions from two handlers over one runtime', async () => {
    const runtime = assembleStandInRuntime();
    const first = await serveHandler(runtime, {
      extensions: [fixedAnswerExtension('/extensions/first', 'first')],
    });
    const second = await serveHandler(runtime, {
      extensions: [fixedAnswerExtension('/extensions/second', 'second')],
    });

    const answers = await Promise.all(
      [
        `${first.baseUrl}/extensions/first`,
        `${first.baseUrl}/extensions/second`,
        `${second.baseUrl}/extensions/first`,
        `${second.baseUrl}/extensions/second`,
      ].map(async (url) => {
        const response = await fetch(url);
        return [response.status, await response.text()];
      })
    );

    expect(answers).toEqual([
      [200, 'first'],
      [404, ''],
      [404, ''],
      [200, 'second'],
    ]);
  });

  describe('start', () => {
    function startingExtension(name: string, start: GatewayExtension['start']): GatewayExtension {
      return { name, handler: () => false, start };
    }

    it('runs the start hook of each extension, in order, and only when it is called', async () => {
      const handler = createGatewayRequestHandler(
        assembleStandInRuntime(),
        handlerOptions({
          extensions: [
            startingExtension('first', () => {
              events.push('first');
            }),
            // Slower than the one after it, so the order holds only if each
            // hook is awaited before the next one runs.
            startingExtension('second', async () => {
              await new Promise((resolve) => setImmediate(resolve));
              events.push('second');
            }),
            startingExtension('without a hook', undefined),
            startingExtension('third', () => {
              events.push('third');
            }),
          ],
        })
      );
      expect(events).toEqual([]);

      await handler.start();

      expect(events).toEqual(['first', 'second', 'third']);
    });

    it('rejects with ExtensionStartError when a start hook throws, and starts none after it', async () => {
      const handler = createGatewayRequestHandler(
        assembleStandInRuntime(),
        handlerOptions({
          extensions: [
            startingExtension('first', () => {
              events.push('first');
            }),
            startingExtension('database', () => {
              throw new StandInFailure('no database to connect to');
            }),
            startingExtension('third', () => {
              events.push('third');
            }),
          ],
        })
      );

      const starting = handler.start();

      await expect(starting).rejects.toBeInstanceOf(ExtensionStartError);
      await expect(starting).rejects.toThrow(
        "Extension 'database' failed to start: no database to connect to"
      );
      expect(events).toEqual(['first']);
    });
  });

  describe('a permissions-override token minted with the exported functions', () => {
    const ALLOW_THIS_GATEWAY = {
      schemas: {
        'this-gateway': {
          properties: { domain: { const: 'latchkey-self.invalid' } },
          required: ['domain'],
        },
        anything: {},
      },
      rules: [{ 'this-gateway': ['anything'] }],
    };
    const DENY_EVERYTHING = { rules: [] };

    let overridePath: string;
    let receivedContexts: ExtensionContext[];
    let contextRecorder: GatewayExtension;

    function createRealRuntime(
      runtimeDirectory: string,
      encryptionKey: string
    ): Promise<LatchkeyRuntime> {
      return createLatchkeyRuntime({
        directory: runtimeDirectory,
        encryptionKey,
        log: () => undefined,
        errorLog: () => undefined,
      });
    }

    beforeEach(() => {
      overridePath = join(temporaryDirectory, 'override-permissions.json');
      writeFileSync(overridePath, JSON.stringify(ALLOW_THIS_GATEWAY), 'utf-8');
      receivedContexts = [];
      contextRecorder = {
        name: 'context recorder',
        handler: (_request, response, context) => {
          receivedContexts.push(context);
          response.writeHead(200);
          response.end();
          return true;
        },
      };
    });

    it('is accepted by a handler over a runtime created with the same key', async () => {
      const encryptionKey = generateKey();
      const signingKey = derivePermissionsOverrideSigningKey(encryptionKey);
      const token = createPermissionsOverrideJwt(overridePath, signingKey);
      const runtime = await createRealRuntime(directory, encryptionKey);
      // The permissions of the directory refuse every request, so one that
      // reaches the extension was checked against the file the token names.
      writeFileSync(runtime.config.permissionsConfigPath, JSON.stringify(DENY_EVERYTHING), 'utf-8');
      const { baseUrl } = await serveHandler(runtime, { extensions: [contextRecorder] });

      const withoutToken = await fetch(`${baseUrl}/extensions/anything`);
      expect(withoutToken.status).toBe(403);
      expect(receivedContexts).toEqual([]);

      const withToken = await fetch(`${baseUrl}/extensions/anything`, {
        headers: { [PERMISSIONS_OVERRIDE_HEADER]: token },
      });

      expect(withToken.status).toBe(200);
      expect(receivedContexts).toEqual([{ permissionsConfigPath: overridePath }]);
      expect(verifyPermissionsOverrideJwt(token, signingKey)).toEqual({
        permissionsConfig: overridePath,
      });
    });

    it('is refused by a handler over a runtime created with another key', async () => {
      const token = createPermissionsOverrideJwt(
        overridePath,
        derivePermissionsOverrideSigningKey(generateKey())
      );
      const runtime = await createRealRuntime(directory, generateKey());
      const { baseUrl } = await serveHandler(runtime, { extensions: [contextRecorder] });

      const response = await fetch(`${baseUrl}/extensions/anything`, {
        headers: { [PERMISSIONS_OVERRIDE_HEADER]: token },
      });

      expect(response.status).toBe(401);
      expect(((await response.json()) as ErrorBody).latchkeyError).toBe(true);
      expect(receivedContexts).toEqual([]);
    });
  });
});
