import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GatewayRequestHandler } from '../src/index.js';

const MOUNT_PATH = '/internal/latchkey';
const PASSWORD = 'embedded-test-password';

describe('createEmbeddedGateway', () => {
  let directory: string;
  let gateway: GatewayRequestHandler;
  let hostServer: http.Server;
  let hostUrl: string;
  const logs: string[] = [];
  const lifecycleCalls: string[] = [];

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'latchkey-embedded-test-'));
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

  it('enforces the password from the environment', async () => {
    const response = await fetch(`${hostUrl}${MOUNT_PATH}/gateway/https://slack.com/api/auth.test`);
    expect(response.status).toBe(401);
    expect(logs.some((line) => line.includes('401 (password)'))).toBe(true);
  });
});
