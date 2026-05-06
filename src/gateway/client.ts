/**
 * Client used by the CLI when `LATCHKEY_GATEWAY` is set.
 *
 * Commands are forwarded to the gateway's `/latchkey/` RPC endpoint, while
 * `latchkey curl` has its target URL rewritten to route through `/gateway/`.
 */

import type { LatchkeyRequest } from './latchkeyEndpoint.js';
import { GATEWAY_PASSWORD_HEADER } from './password.js';
import { PERMISSIONS_OVERRIDE_HEADER } from './permissionsOverride.js';

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

export class GatewayCurlRewriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayCurlRewriteError';
  }
}

function buildEndpointUrl(gatewayUrl: string, path: string): string {
  const base = gatewayUrl.replace(/\/+$/, '');
  return `${base}${path}`;
}

/**
 * POST a request to the gateway's `/latchkey/` endpoint and return its `result`.
 * When `password` is provided, it is sent in the gateway password header so
 * the request can be authenticated by a password-protected gateway. When
 * `permissionsOverride` is provided, it is sent in the permissions-override
 * header so the gateway uses an alternative permissions.json for this request.
 */
export async function callLatchkeyEndpoint(
  gatewayUrl: string,
  request: LatchkeyRequest,
  password: string | null = null,
  permissionsOverride: string | null = null
): Promise<unknown> {
  const endpoint = buildEndpointUrl(gatewayUrl, '/latchkey');

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (password !== null) {
    headers[GATEWAY_PASSWORD_HEADER] = password;
  }
  if (permissionsOverride !== null) {
    headers[PERMISSIONS_OVERRIDE_HEADER] = permissionsOverride;
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GatewayRequestError(`Failed to reach latchkey gateway at ${endpoint}: ${message}`, 0);
  }

  const bodyText = await response.text();
  let parsedBody: { result?: unknown; error?: string };
  try {
    parsedBody =
      bodyText === '' ? {} : (JSON.parse(bodyText) as { result?: unknown; error?: string });
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
 *
 * When `password` is provided, an `-H` argument carrying the gateway
 * password header is prepended so the rewritten curl call can authenticate
 * against a password-protected gateway. When `permissionsOverride` is
 * provided, an `-H` argument carrying the permissions-override JWT is also
 * prepended.
 */
export function rewriteCurlArgumentsForGateway(
  curlArguments: readonly string[],
  targetUrl: string,
  gatewayUrl: string,
  password: string | null = null,
  permissionsOverride: string | null = null
): readonly string[] {
  const occurrences = curlArguments.reduce(
    (count, argument) => (argument === targetUrl ? count + 1 : count),
    0
  );
  if (occurrences === 0) {
    throw new GatewayCurlRewriteError(
      `Target URL '${targetUrl}' not found in curl arguments; refusing to rewrite.`
    );
  }
  if (occurrences > 1) {
    throw new GatewayCurlRewriteError(
      `Target URL '${targetUrl}' appears ${occurrences.toString()} times in curl arguments; ` +
        `refusing to rewrite to avoid ambiguous substitution.`
    );
  }
  const proxyUrl = buildGatewayProxyUrl(gatewayUrl, targetUrl);
  const rewritten = curlArguments.map((argument) => (argument === targetUrl ? proxyUrl : argument));
  const extraHeaders: string[] = [];
  if (password !== null) {
    extraHeaders.push('-H', `${GATEWAY_PASSWORD_HEADER}: ${password}`);
  }
  if (permissionsOverride !== null) {
    extraHeaders.push('-H', `${PERMISSIONS_OVERRIDE_HEADER}: ${permissionsOverride}`);
  }
  return [...extraHeaders, ...rewritten];
}
