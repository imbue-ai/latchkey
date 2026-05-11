import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CliDependencies } from '../src/cliCommands.js';
import { ApiCredentialStore } from '../src/apiCredentials/store.js';
import { Config } from '../src/config.js';
import { EncryptedStorage } from '../src/encryptedStorage.js';
import { ServiceRegistry } from '../src/serviceRegistry.js';
import { startGateway, type GatewayServer } from '../src/gateway/server.js';
import {
  derivePermissionsOverrideSigningKey,
  createPermissionsOverrideJwt,
  PERMISSIONS_OVERRIDE_HEADER,
} from '../src/gateway/permissionsOverride.js';
import type { GatewayOptions } from '../src/gateway/gatewayEndpoint.js';
import {
  EXTENSION_PLACEHOLDER_HOST,
  ExtensionLoadError,
  ExtensionStartError,
  loadExtensions,
  startExtensions,
  stopExtensions,
} from '../src/gateway/extensions.js';
import type { CurlResult, AsyncCurlResult } from '../src/curl.js';
import { GATEWAY_PASSWORD_HEADER } from '../src/gateway/password.js';

const TEST_ENCRYPTION_KEY = 'dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleXRlc3Q=';

function writeExtension(directory: string, fileName: string, source: string): string {
  const filePath = join(directory, fileName);
  writeFileSync(filePath, source, 'utf-8');
  return filePath;
}

// ─── Unit tests: loadExtensions ───────────────────────────────────────────────

describe('loadExtensions', () => {
  let tempDir: string;
  let extensionsDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'latchkey-ext-test-'));
    extensionsDir = join(tempDir, 'extensions');
    mkdirSync(extensionsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns an empty list when the directory does not exist', async () => {
    const extensions = await loadExtensions(join(tempDir, 'nonexistent'));
    expect(extensions).toEqual([]);
  });

  it('returns an empty list when the path is a file, not a directory', async () => {
    const filePath = join(tempDir, 'not-a-dir');
    writeFileSync(filePath, 'noop', 'utf-8');
    const extensions = await loadExtensions(filePath);
    expect(extensions).toEqual([]);
  });

  it('skips files with unsupported suffixes (including .js)', async () => {
    writeExtension(extensionsDir, 'README.txt', 'not an extension');
    writeExtension(extensionsDir, 'config.json', '{}');
    // .js is intentionally not supported: extensions must be `.mjs` so Node
    // never has to fall back to the CommonJS-then-ESM reparse, which emits
    // a MODULE_TYPELESS_PACKAGE_JSON warning.
    writeExtension(extensionsDir, 'looks-like-an-extension.js', `export default () => false;`);
    const extensions = await loadExtensions(extensionsDir);
    expect(extensions).toEqual([]);
  });

  it('loads a single .mjs extension', async () => {
    writeExtension(
      extensionsDir,
      'hello.mjs',
      `export default async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('hi');
        return true;
      };`
    );
    const extensions = await loadExtensions(extensionsDir);
    expect(extensions).toHaveLength(1);
    expect(extensions[0]!.sourceFile).toContain('hello.mjs');
    expect(typeof extensions[0]!.handler).toBe('function');
  });

  it('loads multiple files in deterministic alphabetical order', async () => {
    writeExtension(extensionsDir, 'b-second.mjs', `export default () => false;`);
    writeExtension(extensionsDir, 'a-first.mjs', `export default () => false;`);
    const extensions = await loadExtensions(extensionsDir);
    expect(extensions.map((extension) => extension.sourceFile.endsWith('a-first.mjs'))).toEqual([
      true,
      false,
    ]);
    expect(extensions.map((extension) => extension.sourceFile.endsWith('b-second.mjs'))).toEqual([
      false,
      true,
    ]);
  });

  it('throws ExtensionLoadError when a file has a syntax error', async () => {
    writeExtension(extensionsDir, 'broken.mjs', 'this is not valid javascript ((((');
    await expect(loadExtensions(extensionsDir)).rejects.toThrow(ExtensionLoadError);
  });

  it('throws ExtensionLoadError when there is no default export', async () => {
    writeExtension(extensionsDir, 'no-default.mjs', `export const handler = () => {};`);
    await expect(loadExtensions(extensionsDir)).rejects.toThrow(/must export a default function/);
  });

  it('throws ExtensionLoadError when the default export is not a function', async () => {
    writeExtension(extensionsDir, 'object-default.mjs', `export default { handler: () => {} };`);
    await expect(loadExtensions(extensionsDir)).rejects.toThrow(/must export a default function/);
  });

  it('exposes optional start and stop hooks when the module exports them', async () => {
    writeExtension(
      extensionsDir,
      'hooks.mjs',
      `export default () => false;
       export const start = async () => {};
       export const stop = () => {};`
    );
    const extensions = await loadExtensions(extensionsDir);
    expect(extensions).toHaveLength(1);
    expect(typeof extensions[0]!.start).toBe('function');
    expect(typeof extensions[0]!.stop).toBe('function');
  });

  it('leaves start and stop undefined when the module does not export them', async () => {
    writeExtension(extensionsDir, 'nohooks.mjs', `export default () => false;`);
    const extensions = await loadExtensions(extensionsDir);
    expect(extensions[0]!.start).toBeUndefined();
    expect(extensions[0]!.stop).toBeUndefined();
  });

  it('throws ExtensionLoadError when start is exported but is not a function', async () => {
    writeExtension(
      extensionsDir,
      'badstart.mjs',
      `export default () => false;
       export const start = 'not-a-function';`
    );
    await expect(loadExtensions(extensionsDir)).rejects.toThrow(
      /exports 'start' but it is not a function/
    );
  });

  it('throws ExtensionLoadError when stop is exported but is not a function', async () => {
    writeExtension(
      extensionsDir,
      'badstop.mjs',
      `export default () => false;
       export const stop = 42;`
    );
    await expect(loadExtensions(extensionsDir)).rejects.toThrow(
      /exports 'stop' but it is not a function/
    );
  });
});

// ─── Unit tests: startExtensions / stopExtensions ────────────────────────────

describe('startExtensions / stopExtensions', () => {
  let tempDir: string;
  let extensionsDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'latchkey-ext-lifecycle-'));
    extensionsDir = join(tempDir, 'extensions');
    mkdirSync(extensionsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeFakeDeps(errorLogs: string[]): CliDependencies {
    return {
      registry: new ServiceRegistry([]),
      config: new Config(() => undefined),
      runCurl: (): CurlResult => ({ returncode: 0, stdout: '', stderr: '' }),
      runCurlAsync: (): Promise<AsyncCurlResult> =>
        Promise.resolve({ returncode: 0, stdout: Buffer.alloc(0), stderr: '' }),
      checkPermission: () => Promise.resolve(true),
      confirm: () => Promise.resolve(true),
      exit: (code: number): never => {
        throw new Error(`process.exit(${String(code)})`);
      },
      log: (_message: string) => {
        // intentionally ignored in lifecycle tests
      },
      errorLog: (message: string) => {
        errorLogs.push(message);
      },
      version: '0.0.0-test',
    };
  }

  it('calls start on every extension in load order', async () => {
    const recordPath = join(tempDir, 'order.txt');
    writeExtension(
      extensionsDir,
      'a.mjs',
      `import { appendFileSync } from 'node:fs';
       export default () => false;
       export const start = () => appendFileSync(${JSON.stringify(recordPath)}, 'a-start\\n');`
    );
    writeExtension(
      extensionsDir,
      'b.mjs',
      `import { appendFileSync } from 'node:fs';
       export default () => false;
       export const start = () => appendFileSync(${JSON.stringify(recordPath)}, 'b-start\\n');`
    );
    const extensions = await loadExtensions(extensionsDir);
    await startExtensions(extensions);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(recordPath, 'utf-8')).toBe('a-start\nb-start\n');
  });

  it('awaits async start hooks before resuming', async () => {
    const recordPath = join(tempDir, 'async-start.txt');
    writeExtension(
      extensionsDir,
      'slow.mjs',
      `import { writeFileSync } from 'node:fs';
       export default () => false;
       export const start = () => new Promise((resolve) => {
         setTimeout(() => {
           writeFileSync(${JSON.stringify(recordPath)}, 'started');
           resolve();
         }, 20);
       });`
    );
    const extensions = await loadExtensions(extensionsDir);
    await startExtensions(extensions);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(recordPath, 'utf-8')).toBe('started');
  });

  it('throws ExtensionStartError when a start hook throws and aborts subsequent starts', async () => {
    const recordPath = join(tempDir, 'aborted.txt');
    writeExtension(
      extensionsDir,
      'a-boom.mjs',
      `export default () => false;
       export const start = () => { throw new Error('start-failed'); };`
    );
    writeExtension(
      extensionsDir,
      'b-should-not-run.mjs',
      `import { writeFileSync } from 'node:fs';
       export default () => false;
       export const start = () => writeFileSync(${JSON.stringify(recordPath)}, 'b-started');`
    );
    const extensions = await loadExtensions(extensionsDir);
    await expect(startExtensions(extensions)).rejects.toThrow(ExtensionStartError);
    await expect(startExtensions(extensions)).rejects.toThrow(/start-failed/);
    expect(existsSync(recordPath)).toBe(false);
  });

  it('calls stop on every extension in load order', async () => {
    const recordPath = join(tempDir, 'stop-order.txt');
    writeExtension(
      extensionsDir,
      'a.mjs',
      `import { appendFileSync } from 'node:fs';
       export default () => false;
       export const stop = () => appendFileSync(${JSON.stringify(recordPath)}, 'a-stop\\n');`
    );
    writeExtension(
      extensionsDir,
      'b.mjs',
      `import { appendFileSync } from 'node:fs';
       export default () => false;
       export const stop = () => appendFileSync(${JSON.stringify(recordPath)}, 'b-stop\\n');`
    );
    const extensions = await loadExtensions(extensionsDir);
    const errorLogs: string[] = [];
    await stopExtensions(extensions, makeFakeDeps(errorLogs));
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(recordPath, 'utf-8')).toBe('a-stop\nb-stop\n');
    expect(errorLogs).toEqual([]);
  });

  it('logs and swallows errors thrown by stop hooks, continuing with subsequent extensions', async () => {
    const recordPath = join(tempDir, 'stop-continued.txt');
    writeExtension(
      extensionsDir,
      'a-boom.mjs',
      `export default () => false;
       export const stop = () => { throw new Error('stop-failed'); };`
    );
    writeExtension(
      extensionsDir,
      'b-still-runs.mjs',
      `import { writeFileSync } from 'node:fs';
       export default () => false;
       export const stop = () => writeFileSync(${JSON.stringify(recordPath)}, 'b-stopped');`
    );
    const extensions = await loadExtensions(extensionsDir);
    const errorLogs: string[] = [];
    await stopExtensions(extensions, makeFakeDeps(errorLogs));
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(recordPath, 'utf-8')).toBe('b-stopped');
    expect(errorLogs.some((message) => message.includes('stop-failed'))).toBe(true);
  });

  it('skips extensions without lifecycle hooks', async () => {
    writeExtension(extensionsDir, 'plain.mjs', `export default () => false;`);
    const extensions = await loadExtensions(extensionsDir);
    const errorLogs: string[] = [];
    await expect(startExtensions(extensions)).resolves.toBeUndefined();
    await expect(stopExtensions(extensions, makeFakeDeps(errorLogs))).resolves.toBeUndefined();
  });
});

// ─── Integration tests via startGateway ───────────────────────────────────────

describe('gateway extensions integration', () => {
  let tempDir: string;
  let extensionsDir: string;
  let gateway: GatewayServer | undefined;
  let logs: string[];
  let errorLogs: string[];
  let mockPermissionResult: boolean;
  let lastPermissionCheckRequest: Request | undefined;
  let lastPermissionCheckPath: string | undefined;

  function createMockConfig(): Config {
    return new Config((name) => {
      if (name === 'LATCHKEY_DIRECTORY') return tempDir;
      if (name === 'LATCHKEY_ENCRYPTION_KEY') return TEST_ENCRYPTION_KEY;
      return undefined;
    });
  }

  async function createTestGateway(
    optionOverrides: Partial<GatewayOptions> = {}
  ): Promise<GatewayServer> {
    const credentialsPath = join(tempDir, 'credentials.json.enc');
    const encryptedStorage = new EncryptedStorage(TEST_ENCRYPTION_KEY);
    encryptedStorage.writeFile(credentialsPath, '{}');
    const apiCredentialStore = new ApiCredentialStore(credentialsPath, encryptedStorage);

    const config = createMockConfig();
    const deps: CliDependencies = {
      registry: new ServiceRegistry([]),
      config,
      runCurl: (): CurlResult => ({ returncode: 0, stdout: '', stderr: '' }),
      runCurlAsync: (): Promise<AsyncCurlResult> =>
        Promise.resolve({ returncode: 0, stdout: Buffer.alloc(0), stderr: '' }),
      checkPermission: (
        request: Request,
        configPath: string,
        _builtin: boolean
      ): Promise<boolean> => {
        lastPermissionCheckRequest = request;
        lastPermissionCheckPath = configPath;
        return Promise.resolve(mockPermissionResult);
      },
      confirm: () => Promise.resolve(true),
      exit: (code: number): never => {
        throw new Error(`process.exit(${String(code)})`);
      },
      log: (message: string) => {
        logs.push(message);
      },
      errorLog: (message: string) => {
        errorLogs.push(message);
      },
      version: '0.0.0-test',
    };

    const options: GatewayOptions = {
      port: 0,
      host: 'localhost',
      maxBodySize: 10 * 1024 * 1024,
      password: null,
      permissionsOverrideSigningKey: derivePermissionsOverrideSigningKey(TEST_ENCRYPTION_KEY),
      ...optionOverrides,
    };

    return startGateway(deps, apiCredentialStore, encryptedStorage, options);
  }

  function getHost(): string {
    if (gateway === undefined) throw new Error('Gateway not started');
    const address = gateway.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Failed to get server address');
    }
    const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
    return `http://${host}:${String(address.port)}`;
  }

  function fetch(path: string, options: RequestInit = {}): Promise<Response> {
    return globalThis.fetch(`${getHost()}${path}`, options);
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'latchkey-ext-int-'));
    extensionsDir = join(tempDir, 'extensions');
    mkdirSync(extensionsDir, { recursive: true });
    logs = [];
    errorLogs = [];
    mockPermissionResult = true;
    lastPermissionCheckRequest = undefined;
    lastPermissionCheckPath = undefined;
  });

  afterEach(async () => {
    if (gateway) {
      await gateway.close();
      gateway = undefined;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('serves an extension that claims a request', async () => {
    writeExtension(
      extensionsDir,
      'echo.mjs',
      `export default (req, res) => {
        if (req.url === '/extensions/echo') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ url: req.url }));
          return true;
        }
        return false;
      };`
    );

    gateway = await createTestGateway();
    const response = await fetch('/extensions/echo');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string };
    expect(body.url).toBe('/extensions/echo');
  });

  it('falls through to 404 when no extension claims the request', async () => {
    writeExtension(
      extensionsDir,
      'narrow.mjs',
      `export default (req, res) => {
        if (req.url === '/extensions/specific') {
          res.writeHead(200);
          res.end();
          return true;
        }
        return false;
      };`
    );
    gateway = await createTestGateway();
    const response = await fetch('/extensions/different');
    expect(response.status).toBe(404);
  });

  it('returns 404 when no extensions are installed', async () => {
    rmSync(extensionsDir, { recursive: true, force: true });
    gateway = await createTestGateway();
    const response = await fetch('/extensions/anything');
    expect(response.status).toBe(404);
  });

  it('tries extensions in alphabetical order; first to return true wins', async () => {
    writeExtension(
      extensionsDir,
      'a-claim.mjs',
      `export default (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('a');
        return true;
      };`
    );
    writeExtension(
      extensionsDir,
      'b-also-claim.mjs',
      `export default (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('b');
        return true;
      };`
    );
    gateway = await createTestGateway();
    const response = await fetch('/anything');
    expect(await response.text()).toBe('a');
  });

  it('continues to the next extension when one returns false', async () => {
    writeExtension(extensionsDir, 'a-defer.mjs', `export default (req, res) => false;`);
    writeExtension(
      extensionsDir,
      'b-claim.mjs',
      `export default (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('handled-by-b');
        return true;
      };`
    );
    gateway = await createTestGateway();
    const response = await fetch('/whatever');
    expect(await response.text()).toBe('handled-by-b');
  });

  it('preserves query string for the handler and in the permission check', async () => {
    writeExtension(
      extensionsDir,
      'q.mjs',
      `export default (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(req.url);
        return true;
      };`
    );

    gateway = await createTestGateway();
    const response = await fetch('/extensions/q?x=1&y=2');
    expect(await response.text()).toBe('/extensions/q?x=1&y=2');

    const synthesizedUrl = lastPermissionCheckRequest?.url ?? '';
    expect(synthesizedUrl).toContain('?x=1&y=2');
    expect(synthesizedUrl).toContain(EXTENSION_PLACEHOLDER_HOST);
  });

  it('returns 403 when the permission check denies the request, before any extension is invoked', async () => {
    writeExtension(
      extensionsDir,
      'should-not-run.mjs',
      `export default (req, res) => {
        res.writeHead(200);
        res.end('should not happen');
        return true;
      };`
    );

    mockPermissionResult = false;
    gateway = await createTestGateway();
    const response = await fetch('/anything');
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain('not permitted');
  });

  it('returns 500 and logs when an extension throws', async () => {
    writeExtension(
      extensionsDir,
      'boom.mjs',
      `export default () => {
        throw new Error('boom!');
      };`
    );

    gateway = await createTestGateway();
    const response = await fetch('/extensions/boom');
    expect(response.status).toBe(500);
    expect(errorLogs.some((message) => message.includes('boom!'))).toBe(true);
  });

  it('does not call later extensions after one throws', async () => {
    writeExtension(
      extensionsDir,
      'a-throws.mjs',
      `export default () => {
        throw new Error('first failed');
      };`
    );
    writeExtension(
      extensionsDir,
      'b-claim.mjs',
      `export default (req, res) => {
        res.writeHead(200);
        res.end('b');
        return true;
      };`
    );
    gateway = await createTestGateway();
    const response = await fetch('/path');
    expect(response.status).toBe(500);
  });

  it('does not let extensions intercept the health endpoint', async () => {
    writeExtension(
      extensionsDir,
      'broad.mjs',
      `export default (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('hijacked');
        return true;
      };`
    );
    gateway = await createTestGateway();
    const response = await fetch('/');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('does not offer /gateway/<malformed-url> requests to extensions', async () => {
    writeExtension(
      extensionsDir,
      'broad.mjs',
      `export default (req, res) => {
        res.writeHead(200);
        res.end('hijacked');
        return true;
      };`
    );
    gateway = await createTestGateway();
    const response = await fetch('/gateway/not-a-url');
    expect(response.status).toBe(400);
  });

  it('does not offer /latchkey/ requests to extensions', async () => {
    writeExtension(
      extensionsDir,
      'broad.mjs',
      `export default (req, res) => {
        res.writeHead(200);
        res.end('hijacked');
        return true;
      };`
    );
    gateway = await createTestGateway();
    const response = await fetch('/latchkey/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'auth list' }),
    });
    // Should be handled by the latchkey RPC endpoint, not the extension.
    expect(response.status).toBe(200);
  });

  it('fails startup when an extension is malformed', async () => {
    writeExtension(extensionsDir, 'broken.mjs', 'syntax error (((');
    await expect(createTestGateway()).rejects.toThrow(ExtensionLoadError);
  });

  it('still requires the gateway password for extension routes', async () => {
    writeExtension(
      extensionsDir,
      'pw.mjs',
      `export default (req, res) => {
        res.writeHead(200);
        res.end('ok');
        return true;
      };`
    );
    gateway = await createTestGateway({ password: 'sekret' });

    const denied = await fetch('/extensions/pw');
    expect(denied.status).toBe(401);

    const allowed = await fetch('/extensions/pw', {
      headers: { [GATEWAY_PASSWORD_HEADER]: 'sekret' },
    });
    expect(allowed.status).toBe(200);
  });

  it('honors the permissions-override JWT for extension routes', async () => {
    writeExtension(
      extensionsDir,
      'perm.mjs',
      `export default (req, res) => {
        res.writeHead(200);
        res.end('ok');
        return true;
      };`
    );
    const overridePath = join(tempDir, 'override-permissions.json');
    writeFileSync(overridePath, '{"rules":[]}', 'utf-8');
    const signingKey = derivePermissionsOverrideSigningKey(TEST_ENCRYPTION_KEY);
    const jwt = createPermissionsOverrideJwt(overridePath, signingKey);

    gateway = await createTestGateway();
    const response = await fetch('/extensions/perm', {
      headers: { [PERMISSIONS_OVERRIDE_HEADER]: jwt },
    });
    expect(response.status).toBe(200);
    expect(lastPermissionCheckPath).toBe(overridePath);
  });

  it('returns 401 for an invalid permissions-override JWT', async () => {
    writeExtension(
      extensionsDir,
      'p.mjs',
      `export default (req, res) => {
        res.writeHead(200);
        res.end('ok');
        return true;
      };`
    );
    gateway = await createTestGateway();
    const response = await fetch('/extensions/p', {
      headers: { [PERMISSIONS_OVERRIDE_HEADER]: 'not.a.jwt' },
    });
    expect(response.status).toBe(401);
  });

  it('supports handlers that complete asynchronously after reading the request body', async () => {
    writeExtension(
      extensionsDir,
      'echo-body.mjs',
      `export default (req, res) =>
        new Promise((resolve) => {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(body.toUpperCase());
            resolve(true);
          });
        });`
    );
    gateway = await createTestGateway();
    const response = await fetch('/extensions/echo-body', {
      method: 'POST',
      body: 'hello',
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('HELLO');
  });

  it('logs the extension request line with the actual response status', async () => {
    writeExtension(
      extensionsDir,
      'log.mjs',
      `export default (req, res) => {
        res.writeHead(202);
        res.end();
        return true;
      };`
    );
    gateway = await createTestGateway();
    const response = await fetch('/extensions/log');
    await response.text();
    expect(logs).toContain('GET /extensions/log -> 202 (extension)');
  });

  it('invokes extension start hooks before the HTTP listener accepts requests, and stop hooks at shutdown', async () => {
    const markerPath = join(tempDir, 'lifecycle.txt');
    writeExtension(
      extensionsDir,
      'lifecycle.mjs',
      `import { appendFileSync } from 'node:fs';
       export default (req, res) => {
         res.writeHead(200, { 'Content-Type': 'text/plain' });
         res.end('ok');
         return true;
       };
       export const start = () => appendFileSync(${JSON.stringify(markerPath)}, 'start\\n');
       export const stop = () => appendFileSync(${JSON.stringify(markerPath)}, 'stop\\n');`
    );

    gateway = await createTestGateway();
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(markerPath, 'utf-8')).toBe('start\n');

    const response = await fetch('/extensions/lifecycle');
    expect(response.status).toBe(200);

    await gateway.close();
    gateway = undefined;
    expect(readFileSync(markerPath, 'utf-8')).toBe('start\nstop\n');
  });

  it('aborts gateway startup when an extension start hook throws', async () => {
    writeExtension(
      extensionsDir,
      'cant-start.mjs',
      `export default () => false;
       export const start = () => { throw new Error('nope'); };`
    );
    await expect(createTestGateway()).rejects.toThrow(ExtensionStartError);
  });

  it('lets a stop hook proactively end long-lived streams so shutdown completes promptly', async () => {
    writeExtension(
      extensionsDir,
      'stream.mjs',
      `const openResponses = new Set();
       export default (req, res) => {
         if (req.url !== '/extensions/stream') return false;
         res.writeHead(200, { 'Content-Type': 'text/plain' });
         res.flushHeaders();
         res.write('hello\\n');
         openResponses.add(res);
         return new Promise((resolve) => {
           const finish = () => {
             openResponses.delete(res);
             if (!res.writableEnded) res.end();
             resolve(true);
           };
           req.on('close', finish);
         });
       };
       export const stop = () => {
         for (const res of openResponses) {
           if (!res.writableEnded) res.end();
         }
       };`
    );
    gateway = await createTestGateway();

    // Open a long-lived stream and read the initial chunk so we know the
    // handler is parked on the close promise.
    const controller = new AbortController();
    const responsePromise = fetch('/extensions/stream', { signal: controller.signal });
    const response = await responsePromise;
    expect(response.status).toBe(200);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const firstChunk = await reader.read();
    if (firstChunk.value === undefined) {
      throw new Error('Expected an initial chunk from the streaming extension.');
    }
    expect(new TextDecoder().decode(firstChunk.value)).toBe('hello\n');

    // Shutdown should complete promptly thanks to the stop hook ending
    // the response. The force-close timeout is 10s, so anything well
    // under that proves the stop hook actually fired.
    const startedAt = Date.now();
    await gateway.close();
    gateway = undefined;
    const elapsedMilliseconds = Date.now() - startedAt;
    expect(elapsedMilliseconds).toBeLessThan(2000);

    // The reader should observe end-of-stream.
    const nextChunk = await reader.read();
    expect(nextChunk.done).toBe(true);
    controller.abort();
  });
});
