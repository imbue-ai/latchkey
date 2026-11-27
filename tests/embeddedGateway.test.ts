import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GatewayRequestHandler } from '../src/index.js';

const MOUNT_PATH = '/internal/latchkey';
const PASSWORD = 'embedded-test-password';

function writeDirectoryExtension(latchkeyDirectory: string): void {
  const extensionsDirectory = join(latchkeyDirectory, 'extensions');
  mkdirSync(extensionsDirectory, { recursive: true });
  writeFileSync(
    join(extensionsDirectory, 'from-directory.mjs'),
    `export default (request, response) => {
       if (request.url !== '/extensions/from-directory') return false;
       response.end('hello from the directory');
       return true;
     };`
  );
}

describe('createEmbeddedGateway', () => {
  let directory: string;
  let gateway: GatewayRequestHandler;
  let hostServer: http.Server;
  let hostUrl: string;
  const logs: string[] = [];
  const lifecycleCalls: string[] = [];

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'latchkey-embedded-test-'));
    writeDirectoryExtension(directory);
    vi.stubEnv('LATCHKEY_DIRECTORY', directory);
    vi.stubEnv('LATCHKEY_ENCRYPTION_KEY', 'dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleXRlc3Q=');
    vi.stubEnv('LATCHKEY_GATEWAY_LISTEN_PASSWORD', PASSWORD);
    vi.stubEnv('LATCHKEY_DISABLE_COUNTING', '1');
    vi.stubEnv('LATCHKEY_GATEWAY', '');
    // The configuration is read from the environment when the module loads.
    vi.resetModules();
    const { createEmbeddedGateway } = await import('../src/index.js');
    gateway = await createEmbeddedGateway({
      log: (message) => logs.push(message),
      extensions: [
        {
          name: 'hello',
          start: () => {
            lifecycleCalls.push('start');
          },
          stop: () => {
            lifecycleCalls.push('stop');
          },
          handler: (request, response) => {
            if (request.url !== '/extensions/hello') return false;
            response.end('hello from the host');
            return true;
          },
        },
      ],
    });

    hostServer = http.createServer((request, response) => {
      if (request.url?.startsWith(MOUNT_PATH) === true) {
        request.url = request.url.slice(MOUNT_PATH.length) || '/';
        gateway.handleRequest(request, response);
        return;
      }
      response.end('host');
    });
    await new Promise<void>((resolve) => hostServer.listen(0, '127.0.0.1', resolve));
    hostUrl = `http://127.0.0.1:${String((hostServer.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await gateway.close();
    expect(lifecycleCalls).toEqual(['start', 'stop']);
    await new Promise((resolve) => hostServer.close(resolve));
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it('leaves the other routes of the host server alone', async () => {
    const response = await fetch(`${hostUrl}/something-else`);
    expect(await response.text()).toBe('host');
  });

  it('serves the gateway under the mount path', async () => {
    const response = await fetch(`${hostUrl}${MOUNT_PATH}`, {
      headers: { 'X-Latchkey-Gateway-Password': PASSWORD },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { status: string }).status).toBe('ok');
  });

  it('serves the latchkey endpoint under the mount path', async () => {
    const response = await fetch(`${hostUrl}${MOUNT_PATH}/latchkey`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Latchkey-Gateway-Password': PASSWORD },
      body: JSON.stringify({ command: 'services list', params: { builtin: true } }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: unknown[] };
    expect(body.result.length).toBeGreaterThan(0);
  });

  it('serves extensions passed as functions', async () => {
    const response = await fetch(`${hostUrl}${MOUNT_PATH}/extensions/hello`, {
      headers: { 'X-Latchkey-Gateway-Password': PASSWORD },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello from the host');

    const unclaimed = await fetch(`${hostUrl}${MOUNT_PATH}/extensions/other`, {
      headers: { 'X-Latchkey-Gateway-Password': PASSWORD },
    });
    expect(unclaimed.status).toBe(404);
  });

  it('does not serve the extensions directory when extensions are passed', async () => {
    const response = await fetch(`${hostUrl}${MOUNT_PATH}/extensions/from-directory`, {
      headers: { 'X-Latchkey-Gateway-Password': PASSWORD },
    });
    expect(response.status).toBe(404);
  });

  it('enforces the password from the environment', async () => {
    const response = await fetch(`${hostUrl}${MOUNT_PATH}/gateway/https://slack.com/api/auth.test`);
    expect(response.status).toBe(401);
    expect(logs.some((line) => line.includes('401 (password)'))).toBe(true);
  });
});

describe('createEmbeddedGateway with an environment of its own', () => {
  const password = 'password-from-the-env-option';
  let directory: string;
  let gateway: GatewayRequestHandler;
  let hostServer: http.Server;
  let hostUrl: string;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'latchkey-embedded-env-test-'));
    writeDirectoryExtension(directory);
    const env = {
      LATCHKEY_DIRECTORY: directory,
      LATCHKEY_ENCRYPTION_KEY: 'b3RoZXJrZXlvdGhlcmtleW90aGVya2V5b3RoZXJrZXk=',
      LATCHKEY_GATEWAY_LISTEN_PASSWORD: password,
      LATCHKEY_DISABLE_COUNTING: '1',
    };
    // Whatever the process environment says must not matter.
    vi.stubEnv('LATCHKEY_DIRECTORY', join(directory, 'unused'));
    vi.stubEnv('LATCHKEY_GATEWAY_LISTEN_PASSWORD', 'password-of-the-process');
    vi.stubEnv('LATCHKEY_GATEWAY', 'http://remote-gateway.invalid');
    vi.resetModules();
    const { createEmbeddedGateway, runCli } = await import('../src/index.js');
    const register = await runCli(
      ['services', 'register', 'env-service', '--base-api-url=https://env.example.com/api/'],
      { env }
    );
    expect(register).toEqual({ exitCode: 0, stdout: expect.any(String) as string, stderr: '' });
    gateway = await createEmbeddedGateway({ env, log: () => undefined });

    hostServer = http.createServer(gateway.handleRequest);
    await new Promise<void>((resolve) => hostServer.listen(0, '127.0.0.1', resolve));
    hostUrl = `http://127.0.0.1:${String((hostServer.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await gateway.close();
    await new Promise((resolve) => hostServer.close(resolve));
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it('takes the password from the given environment', async () => {
    const withProcessPassword = await fetch(hostUrl, {
      headers: { 'X-Latchkey-Gateway-Password': 'password-of-the-process' },
    });
    expect(withProcessPassword.status).toBe(401);

    const withGivenPassword = await fetch(hostUrl, {
      headers: { 'X-Latchkey-Gateway-Password': password },
    });
    expect(withGivenPassword.status).toBe(200);
  });

  it('serves the Latchkey directory of the given environment', async () => {
    const response = await fetch(`${hostUrl}/latchkey`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Latchkey-Gateway-Password': password },
      body: JSON.stringify({ command: 'services list', params: {} }),
    });
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain('env-service');
  });

  it('serves the extensions directory when no extensions are passed', async () => {
    const response = await fetch(`${hostUrl}/extensions/from-directory`, {
      headers: { 'X-Latchkey-Gateway-Password': password },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello from the directory');
  });
});
