/**
 * What the tests of the embedding interface share: a server the test owns for
 * a request handler, a request whose raw answer can be inspected, and waiting
 * for a condition without sleeping a fixed time.
 */

import * as http from 'node:http';

export class ConditionTimeoutError extends Error {
  constructor(description: string, timeoutMilliseconds: number) {
    super(`Timed out after ${String(timeoutMilliseconds)} ms waiting for ${description}.`);
    this.name = 'ConditionTimeoutError';
  }
}

export class TestServerAddressError extends Error {
  constructor() {
    super('The test server has no network address.');
    this.name = 'TestServerAddressError';
  }
}

const POLL_INTERVAL_MILLISECONDS = 10;

export function waitFor(
  predicate: () => boolean,
  timeoutMilliseconds: number,
  description: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = (): void => {
      if (predicate()) {
        resolve();
      } else if (Date.now() - startedAt > timeoutMilliseconds) {
        reject(new ConditionTimeoutError(description, timeoutMilliseconds));
      } else {
        setTimeout(check, POLL_INTERVAL_MILLISECONDS);
      }
    };
    check();
  });
}

export interface TestServer {
  readonly server: http.Server;
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

/**
 * Serve a request listener on a server of the test's own, the way a program
 * that embeds the gateway does.
 */
export function serve(listener: http.RequestListener): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(listener);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new TestServerAddressError());
        return;
      }
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        close: () =>
          new Promise((resolveClose) => {
            server.closeAllConnections();
            server.close(() => {
              resolveClose();
            });
          }),
      });
    });
  });
}

export interface ReceivedResponse {
  readonly statusCode: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
  /** False when the connection ended before the whole response had arrived. */
  readonly isComplete: boolean;
}

export interface SentRequestOptions {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly agent?: http.Agent;
  /** Called with each piece of the body as it arrives. */
  readonly onBodyChunk?: (chunk: string) => void;
}

/**
 * Send a request with Node's own client, which shows what `fetch` hides: the
 * `Connection` header of the answer, and a response cut off before its end.
 */
export function sendRequest(
  url: string,
  options: SentRequestOptions = {}
): Promise<ReceivedResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      { method: options.method ?? 'GET', headers: options.headers, agent: options.agent },
      (response) => {
        let body = '';
        response.setEncoding('utf-8');
        response.on('data', (chunk: string) => {
          body += chunk;
          options.onBodyChunk?.(chunk);
        });
        // A response that is cut off reports an error as well; `close` follows
        // either way and is what settles the request.
        response.on('error', () => undefined);
        response.on('close', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body,
            isComplete: response.complete,
          });
        });
      }
    );
    request.on('error', reject);
    request.end();
  });
}

/** What a stand-in throws to play a failure of the thing it stands in for. */
export class StandInFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StandInFailure';
  }
}
