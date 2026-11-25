import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ApiCredentialStore,
  Config,
  createGatewayRequestHandler,
  createLatchkeyRuntime,
  derivePermissionsOverrideSigningKey,
  EncryptedStorage,
  generateKey,
  type GatewayExtension,
  type GatewayRequestHandler,
  type LatchkeyRuntime,
} from '../src/embed.js';
import { BUILTIN_API_CREDENTIALS_TYPES } from '../src/apiCredentials/serialization.js';
import { resetCurlCommand, type AsyncCurlResult } from '../src/curl.js';
import { assembleLatchkeyRuntime, resetClaimedCurlCommand } from '../src/runtime.js';
import {
  sendRequest,
  serve,
  StandInFailure,
  waitFor,
  type TestServer,
} from './embedTestSupport.js';

const MAXIMUM_BODY_SIZE = 10 * 1024 * 1024;
/** A deadline no test is meant to reach: stopping has to finish well before it. */
const DISTANT_DEADLINE_MILLISECONDS = 60_000;
const PROMPT_MILLISECONDS = 10_000;
/** A deadline the tests that end a request do reach. */
const SHORT_DEADLINE_MILLISECONDS = 200;
/** Timers may fire a little early, and ending what is left takes a moment. */
const TIMER_TOLERANCE_MILLISECONDS = 20;
const ENDED_SOON_AFTER_MILLISECONDS = 3_000;

interface ErrorBody {
  readonly error: string;
  readonly latchkeyError: boolean;
}

function isProcessRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

describe('stopping a gateway request handler', () => {
  let temporaryDirectory: string;
  let directory: string;
  let servers: TestServer[];
  let agents: http.Agent[];
  let errorLogs: string[];
  let events: string[];
  let curlInvocations: (readonly string[])[];
  let releaseCurl: () => void;
  let curlReleased: Promise<void>;

  /**
   * A runtime over the test's directory whose permission check allows
   * everything and whose curl runner answers once the test releases it.
   */
  function assembleStandInRuntime(): LatchkeyRuntime {
    const encryptionKey = generateKey();
    const config = new Config(
      (name) => (name === 'LATCHKEY_DIRECTORY' ? directory : undefined),
      () => ({ passthroughUnknown: true })
    );
    const encryptedStorage = new EncryptedStorage(encryptionKey);
    return assembleLatchkeyRuntime({
      config,
      encryptedStorage,
      apiCredentialStore: new ApiCredentialStore(config.credentialStorePath, encryptedStorage),
      baseServices: [],
      apiCredentialsTypes: BUILTIN_API_CREDENTIALS_TYPES,
      permissionsOverrideSigningKey: derivePermissionsOverrideSigningKey(encryptionKey),
      runCurlAsync: async (curlArguments: readonly string[]): Promise<AsyncCurlResult> => {
        curlInvocations.push(curlArguments);
        await curlReleased;
        const headerFilePath = curlArguments[curlArguments.indexOf('-D') + 1]!;
        writeFileSync(headerFilePath, 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n');
        return { returncode: 0, stdout: Buffer.from('the whole answer'), stderr: '' };
      },
      checkPermission: () => Promise.resolve(true),
      log: () => undefined,
      errorLog: (message) => {
        errorLogs.push(message);
      },
      version: '0.0.0-test',
    });
  }

  /** Attach a handler to a server the test creates, as an embedding program does. */
  async function serveHandler(
    runtime: LatchkeyRuntime,
    extensions: readonly GatewayExtension[] = []
  ): Promise<{ readonly handler: GatewayRequestHandler; readonly baseUrl: string }> {
    const handler = createGatewayRequestHandler(runtime, {
      password: null,
      maxBodySize: MAXIMUM_BODY_SIZE,
      extensions,
    });
    await handler.start();
    const server = await serve(handler.handleRequest);
    servers.push(server);
    return { handler, baseUrl: server.baseUrl };
  }

  /** Let everything that is ready to run do so, without waiting for time to pass. */
  function nextTurnOfTheEventLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'latchkey-stop-test-'));
    directory = join(temporaryDirectory, 'latchkey');
    servers = [];
    agents = [];
    errorLogs = [];
    events = [];
    curlInvocations = [];
    curlReleased = new Promise((resolve) => {
      releaseCurl = resolve;
    });
  });

  afterEach(async () => {
    releaseCurl();
    for (const agent of agents) agent.destroy();
    await Promise.all(servers.map((server) => server.close()));
    resetClaimedCurlCommand();
    resetCurlCommand();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('returns the promise of the first call to every later call', async () => {
    const { handler } = await serveHandler(assembleStandInRuntime());

    const first = handler.stop({ deadlineMilliseconds: SHORT_DEADLINE_MILLISECONDS });
    const second = handler.stop({ deadlineMilliseconds: DISTANT_DEADLINE_MILLISECONDS });

    expect(second).toBe(first);
    await first;
    expect(handler.stop({ deadlineMilliseconds: SHORT_DEADLINE_MILLISECONDS })).toBe(first);
  });

  it.each([
    ['GET', '/'],
    ['POST', '/latchkey/'],
    ['GET', '/gateway/https://example.invalid/x'],
    ['GET', '/extensions/hello'],
  ])(
    'answers %s %s with 503 and closes the connection once stop was called',
    async (method, path) => {
      const hello: GatewayExtension = {
        name: 'hello',
        handler: (_request, response) => {
          events.push('extension');
          response.writeHead(200);
          response.end('hello');
          return true;
        },
      };
      const { handler, baseUrl } = await serveHandler(assembleStandInRuntime(), [hello]);
      // A connection that is kept open, so that `Connection: close` in an
      // answer is the gateway's doing and not the client's.
      const agent = new http.Agent({ keepAlive: true });
      agents.push(agent);
      const beforeStop = await sendRequest(`${baseUrl}/`, { agent });
      expect(beforeStop.statusCode).toBe(200);
      expect(beforeStop.headers.connection).toBe('keep-alive');

      const stopping = handler.stop({ deadlineMilliseconds: SHORT_DEADLINE_MILLISECONDS });
      const afterStop = await sendRequest(`${baseUrl}${path}`, { method, agent });
      await stopping;

      expect(afterStop.statusCode).toBe(503);
      expect(afterStop.headers.connection).toBe('close');
      expect((JSON.parse(afterStop.body) as ErrorBody).latchkeyError).toBe(true);
      expect(events).toEqual([]);
      expect(curlInvocations).toEqual([]);
    }
  );

  it('calls the stop hook of each extension in order, past one that throws', async () => {
    function stoppingExtension(name: string, stop: GatewayExtension['stop']): GatewayExtension {
      return { name, handler: () => false, stop };
    }
    const { handler } = await serveHandler(assembleStandInRuntime(), [
      stoppingExtension('first', () => {
        events.push('first');
      }),
      stoppingExtension('throwing', () => {
        events.push('throwing');
        throw new StandInFailure('nothing to flush to');
      }),
      // Slower than the one after it, so the order holds only if each hook is
      // awaited before the next one runs.
      stoppingExtension('slow', async () => {
        await nextTurnOfTheEventLoop();
        events.push('slow');
      }),
      stoppingExtension('rejecting', () => Promise.reject(new StandInFailure('still busy'))),
      stoppingExtension('without a hook', undefined),
      stoppingExtension('last', () => {
        events.push('last');
      }),
    ]);

    await handler.stop({ deadlineMilliseconds: DISTANT_DEADLINE_MILLISECONDS });

    expect(events).toEqual(['first', 'throwing', 'slow', 'last']);
    expect(errorLogs).toEqual([
      "Extension 'throwing' stop hook threw: nothing to flush to",
      "Extension 'rejecting' stop hook threw: still busy",
    ]);
  });

  it('answers in full an extension request that finishes before the deadline, and resolves promptly', async () => {
    let finishResponse: () => void = () => undefined;
    const responseMayFinish = new Promise<void>((resolve) => {
      finishResponse = resolve;
    });
    const twoHalves: GatewayExtension = {
      name: 'two halves',
      handler: async (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.write('first half, ');
        await responseMayFinish;
        events.push('response ended');
        response.end('second half');
        return true;
      },
    };
    const { handler, baseUrl } = await serveHandler(assembleStandInRuntime(), [twoHalves]);
    let receivedChunkCount = 0;
    const responding = sendRequest(`${baseUrl}/extensions/two-halves`, {
      onBodyChunk: () => {
        receivedChunkCount += 1;
      },
    });
    await waitFor(() => receivedChunkCount > 0, PROMPT_MILLISECONDS, 'the first half of the body');

    const startedAt = Date.now();
    const stopping = handler
      .stop({ deadlineMilliseconds: DISTANT_DEADLINE_MILLISECONDS })
      .then(() => {
        events.push('stop resolved');
      });
    await nextTurnOfTheEventLoop();
    expect(events).toEqual([]);
    finishResponse();
    const response = await responding;
    await stopping;

    expect(response).toMatchObject({
      statusCode: 200,
      body: 'first half, second half',
      isComplete: true,
    });
    expect(events).toEqual(['response ended', 'stop resolved']);
    expect(Date.now() - startedAt).toBeLessThan(PROMPT_MILLISECONDS);
    expect(errorLogs).toEqual([]);
  });

  it('answers in full a proxied request that finishes before the deadline, and resolves promptly', async () => {
    const { handler, baseUrl } = await serveHandler(assembleStandInRuntime());
    const responding = sendRequest(`${baseUrl}/gateway/https://example.invalid/x`);
    await waitFor(() => curlInvocations.length > 0, PROMPT_MILLISECONDS, 'curl to be started');

    const startedAt = Date.now();
    const stopping = handler
      .stop({ deadlineMilliseconds: DISTANT_DEADLINE_MILLISECONDS })
      .then(() => {
        events.push('stop resolved');
      });
    await nextTurnOfTheEventLoop();
    expect(events).toEqual([]);
    releaseCurl();
    const response = await responding;
    await stopping;

    expect(response).toMatchObject({
      statusCode: 200,
      body: 'the whole answer',
      isComplete: true,
    });
    expect(events).toEqual(['stop resolved']);
    expect(Date.now() - startedAt).toBeLessThan(PROMPT_MILLISECONDS);
    expect(errorLogs).toEqual([]);
  });

  it('resolves before the deadline when the stop hook of an extension ends the response it kept open', async () => {
    const followers = new Set<http.ServerResponse>();
    const follow: GatewayExtension = {
      name: 'follow',
      handler: (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.write('following');
        followers.add(response);
        return true;
      },
      stop: () => {
        for (const response of followers) response.end(', ended by stop');
      },
    };
    const { handler, baseUrl } = await serveHandler(assembleStandInRuntime(), [follow]);
    let receivedChunkCount = 0;
    const responding = sendRequest(`${baseUrl}/extensions/follow`, {
      onBodyChunk: () => {
        receivedChunkCount += 1;
      },
    });
    await waitFor(() => receivedChunkCount > 0, PROMPT_MILLISECONDS, 'the stream to begin');

    const startedAt = Date.now();
    await handler.stop({ deadlineMilliseconds: DISTANT_DEADLINE_MILLISECONDS });
    const elapsedMilliseconds = Date.now() - startedAt;
    const response = await responding;

    expect(response).toMatchObject({
      statusCode: 200,
      body: 'following, ended by stop',
      isComplete: true,
    });
    expect(elapsedMilliseconds).toBeLessThan(PROMPT_MILLISECONDS);
  });

  it('ends at the deadline an extension response that is never ended', async () => {
    const neverEnding: GatewayExtension = {
      name: 'never ending',
      handler: (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.write('a beginning');
        return true;
      },
    };
    const { handler, baseUrl } = await serveHandler(assembleStandInRuntime(), [neverEnding]);
    let receivedChunkCount = 0;
    const responding = sendRequest(`${baseUrl}/extensions/never-ending`, {
      onBodyChunk: () => {
        receivedChunkCount += 1;
      },
    });
    await waitFor(() => receivedChunkCount > 0, PROMPT_MILLISECONDS, 'the stream to begin');

    const startedAt = Date.now();
    await handler.stop({ deadlineMilliseconds: SHORT_DEADLINE_MILLISECONDS });
    const elapsedMilliseconds = Date.now() - startedAt;
    const response = await responding;

    // The client sees its connection close on a response that was not finished.
    expect(response).toMatchObject({ statusCode: 200, body: 'a beginning', isComplete: false });
    expect(elapsedMilliseconds).toBeGreaterThanOrEqual(
      SHORT_DEADLINE_MILLISECONDS - TIMER_TOLERANCE_MILLISECONDS
    );
    expect(elapsedMilliseconds).toBeLessThan(ENDED_SOON_AFTER_MILLISECONDS);
    expect(errorLogs).toEqual([]);
  });

  describe.skipIf(process.platform === 'win32')('with a curl program that does not finish', () => {
    let curlProcessId: number | null;

    beforeEach(() => {
      curlProcessId = null;
    });

    afterEach(() => {
      if (curlProcessId !== null && isProcessRunning(curlProcessId)) {
        process.kill(curlProcessId, 'SIGKILL');
      }
    });

    it('ends the proxied request at the deadline and leaves no curl process running', async () => {
      const processIdFilePath = join(temporaryDirectory, 'curl.pid');
      const sleepingCurlPath = join(temporaryDirectory, 'sleeping-curl.sh');
      // `exec` keeps the process id, so the one written is the one that sleeps.
      // The file is moved into place so that it is never seen half written.
      writeFileSync(
        sleepingCurlPath,
        [
          '#!/bin/sh',
          `echo $$ > '${processIdFilePath}.partial'`,
          `mv '${processIdFilePath}.partial' '${processIdFilePath}'`,
          'exec sleep 300',
          '',
        ].join('\n'),
        'utf-8'
      );
      chmodSync(sleepingCurlPath, 0o755);
      const runtime = await createLatchkeyRuntime({
        directory,
        encryptionKey: generateKey(),
        settings: { passthroughUnknown: true, curlCommand: sleepingCurlPath },
        log: () => undefined,
        errorLog: (message) => {
          errorLogs.push(message);
        },
      });
      const { handler, baseUrl } = await serveHandler(runtime);
      const outcome = sendRequest(`${baseUrl}/gateway/https://example.invalid/x`).then(
        (response) => `answered ${String(response.statusCode)}`,
        () => 'connection closed without an answer'
      );
      await waitFor(
        () => existsSync(processIdFilePath),
        PROMPT_MILLISECONDS,
        'the curl program to write its process id'
      );
      curlProcessId = Number(readFileSync(processIdFilePath, 'utf-8').trim());
      const sleepingProcessId = curlProcessId;
      expect(isProcessRunning(sleepingProcessId)).toBe(true);

      const startedAt = Date.now();
      await handler.stop({ deadlineMilliseconds: SHORT_DEADLINE_MILLISECONDS });
      const elapsedMilliseconds = Date.now() - startedAt;

      // Checked at once and not after a wait: the promise resolving is what
      // says that no curl process is left.
      expect(isProcessRunning(sleepingProcessId)).toBe(false);
      expect(await outcome).toBe('connection closed without an answer');
      expect(elapsedMilliseconds).toBeGreaterThanOrEqual(
        SHORT_DEADLINE_MILLISECONDS - TIMER_TOLERANCE_MILLISECONDS
      );
      expect(elapsedMilliseconds).toBeLessThan(ENDED_SOON_AFTER_MILLISECONDS);
      expect(errorLogs).toEqual([]);
    });
  });
});
