/**
 * Shared definition for the header that asks the `latchkey gateway` server to
 * forward a `/gateway/<url>` request exactly as received: no service lookup,
 * no credential injection, and no permission check. It is meant for requests
 * that already carry their credentials, injected by another latchkey gateway
 * whose store holds them, and only need this gateway's network position (for
 * example, an egress from the user's own machine rather than a datacenter).
 *
 * The gateway password, when configured, is still required. The header itself
 * is consumed by the gateway and never forwarded upstream.
 *
 * Lowercased to match how Node's `http.IncomingMessage.headers` exposes header
 * names.
 */
export const GATEWAY_NO_CREDENTIALS_HEADER = 'x-latchkey-gateway-no-credentials';
