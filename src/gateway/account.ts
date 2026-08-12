/**
 * Shared definition for the header that carries the selected account from the
 * latchkey CLI (in gateway mode) to the `latchkey gateway` server, so the
 * gateway injects credentials for the account the user chose with `--account`
 * rather than silently falling back to auto-resolution.
 *
 * Lowercased to match how Node's `http.IncomingMessage.headers` exposes header
 * names.
 */
export const GATEWAY_ACCOUNT_HEADER = 'x-latchkey-gateway-account';
