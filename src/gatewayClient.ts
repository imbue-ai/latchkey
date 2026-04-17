/**
 * Client used by the CLI when `LATCHKEY_GATEWAY` is set.
 *
 * Commands are forwarded to the gateway's `/latchkey/` RPC endpoint, while
 * `latchkey curl` has its target URL rewritten to route through `/gateway/`.
 */

import type { LatchkeyRequest } from './latchkeyEndpoint.js';

export class GatewayRequestError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'GatewayRequestError';
    this.statusCode = statusCode;
  }
}

export class GatewayCommandNotSupportedError extends Error {
  constructor(commandName: string) {
    super(
      `'${commandName}' cannot be invoked when LATCHKEY_GATEWAY is set. ` +
        `Unset the environment variable to run it locally.`
    );
    this.name = 'GatewayCommandNotSupportedError';
  }
}

function buildEndpointUrl(gatewayUrl: string, path: string): string {
  const base = gatewayUrl.replace(/\/+$/, '');
  return `${base}${path}`;
}

/**
 * POST a request to the gateway's `/latchkey/` endpoint and return its `result`.
 */
export async function callLatchkeyEndpoint(
  gatewayUrl: string,
  request: LatchkeyRequest
): Promise<unknown> {
  const endpoint = buildEndpointUrl(gatewayUrl, '/latchkey');

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GatewayRequestError(
      `Failed to reach latchkey gateway at ${endpoint}: ${message}`,
      0
    );
  }

  const bodyText = await response.text();
  let parsedBody: { result?: unknown; error?: string };
  try {
    parsedBody =
      bodyText === ''
        ? {}
        : (JSON.parse(bodyText) as { result?: unknown; error?: string });
  } catch {
    throw new GatewayRequestError(
      `Latchkey gateway returned invalid JSON (status ${response.status.toString()}): ${bodyText}`,
      response.status
    );
  }

  if (!response.ok) {
    const message =
      typeof parsedBody.error === 'string'
        ? parsedBody.error
        : `Latchkey gateway returned status ${response.status.toString()}`;
    throw new GatewayRequestError(message, response.status);
  }

  return parsedBody.result ?? null;
}

/**
 * Build the URL used to proxy a `latchkey curl` invocation through the
 * gateway's `/gateway/` endpoint.
 */
export function buildGatewayProxyUrl(gatewayUrl: string, targetUrl: string): string {
  return `${buildEndpointUrl(gatewayUrl, '/gateway/')}${targetUrl}`;
}

/**
 * Rewrite a curl argument list so the target URL points at the gateway's
 * `/gateway/<target>` endpoint. Returns a new array; the original is unchanged.
 */
export function rewriteCurlArgumentsForGateway(
  curlArguments: readonly string[],
  targetUrl: string,
  gatewayUrl: string
): readonly string[] {
  const proxyUrl = buildGatewayProxyUrl(gatewayUrl, targetUrl);
  let rewritten = false;
  return curlArguments.map((argument) => {
    if (!rewritten && argument === targetUrl) {
      rewritten = true;
      return proxyUrl;
    }
    return argument;
  });
}
