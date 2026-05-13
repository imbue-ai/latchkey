# PR: CycleTLS Transport for TLS-Fingerprinted Services

## Problem

DoorDash uses Cloudflare with JA3 TLS fingerprinting. Cloudflare inspects the TLS Client Hello (specifically the JA3 hash) and rejects requests that don't look like a real browser. Plain curl gets 403 on every DoorDash endpoint regardless of headers, User-Agent, or other HTTP-level spoofing.

This breaks two things in latchkey:
1. **`latchkey curl`** — can't make any DoorDash API requests
2. **`latchkey auth list`** (credential validation) — `checkApiCredentials` shells out to curl, gets 403, reports credentials as invalid even when they're fine

Browser login via Playwright works because Playwright launches real Chrome. Cookies get captured and stored. But stored credentials can't be validated or used through latchkey's HTTP layer.

## Why CycleTLS

CycleTLS is a Go-based HTTP client that impersonates Chrome's TLS handshake. It sends a Chrome-like JA3 fingerprint during the TLS negotiation, making Cloudflare think it's a real browser. The `doordash-mcp` project already uses CycleTLS successfully for all DoorDash API calls.

The key insight: this is a TLS-level problem, not HTTP. No amount of header tweaking fixes it. The transport itself must change.

## Design

Services opt into CycleTLS via a `transport` property. The existing curl argument pipeline (permission check, URL extraction, credential injection) runs unchanged. At the final execution step, the transport switches from spawning curl to calling CycleTLS.

CycleTLS is an optional dependency — lazily loaded on first use. Users who don't need it pay no cost.

---

## File-by-File Breakdown

### New Files

#### `src/cycleTlsTransport.ts`

Core CycleTLS wrapper module. Three responsibilities:

**Lazy singleton management** (lines 26-55): CycleTLS spawns a Go binary on init, so we create one instance and reuse it. `getCycleTls()` handles lazy initialization with promise deduplication (concurrent callers share the same init). If `cycletls` isn't installed, throws `CycleTlsNotAvailableError` with install instructions.

**Curl-to-HTTP argument translation** (lines 75-147): `parseCurlArgsToHttp()` converts curl argument arrays into `{url, method, headers, body}`. This bridges the gap between latchkey's curl-centric pipeline and CycleTLS's programmatic API. Handles:
- `-X`/`--request` → method
- `-H`/`--header` → headers dict
- `-d`/`--data`/`--data-raw`/`--data-binary` → body (including `@-` for stdin)
- Skips curl output flags (`-s`, `-o`, `-w`, `-D`) that have no HTTP meaning
- Positional args → URL (last one wins, matching curl behavior)

**Request execution** (lines 152-181): `cycleTlsRequest()` calls CycleTLS with hardcoded Chrome JA3 fingerprint and User-Agent. Returns `{status, headers, body}`.

**Cleanup** (lines 186-196): `closeCycleTls()` shuts down the Go binary. Called after `latchkey curl` completes.

#### `src/cycletls.d.ts`

Minimal TypeScript declarations for the `cycletls` package. Follows the same pattern as the existing `playwright-core.d.ts`. Declares the module shape so the dynamic `import('cycletls')` is type-safe without requiring the package to be installed at build time.

---

### Modified Files

#### `src/services/core/base.ts`

**Added `transport` property** (line 75):
```typescript
readonly transport?: 'curl' | 'cycletls';
```
Optional, defaults to undefined (treated as `'curl'`). Services that need CycleTLS override this.

**Added CycleTLS path to `checkApiCredentials`** (lines 103-115): When `this.transport === 'cycletls'`, dynamically imports `cycleTlsTransport`, parses the curl args into HTTP, makes the request via CycleTLS, and checks for HTTP 200. Falls back to `Invalid` on any error. This is the generic path — services can override `checkApiCredentials` entirely for custom validation logic (DoorDash does this).

#### `src/services/doordash.ts`

**Set transport** (line 130):
```typescript
override readonly transport = 'cycletls' as const;
```

**Custom `checkApiCredentials` override** (lines 147-176): DoorDash overrides the base class method with custom validation that parses the GraphQL JSON response to check for `consumer.id`. **Note: this override currently still uses `runCaptured` (curl), not CycleTLS.** This is a known gap — the override needs to be updated to use the CycleTLS transport when available. The `latchkey curl` command and gateway already use CycleTLS for DoorDash; only this credential check is still curl-based.

Also updated: `credentialCheckCurlArguments` now uses the correct endpoint (`/graphql/consumer?operation=consumer`), adds `Accept: application/json` header, and uses a simpler query. Login detection now has a fallback that polls cookies via the browser context (handles already-logged-in redirects).

#### `src/curlInjection.ts`

**New return type** (lines 81-84):
```typescript
export interface CurlInvocationResult {
  readonly arguments: readonly string[];
  readonly transport: 'curl' | 'cycletls';
}
```

`prepareCurlInvocation` previously returned `Promise<readonly string[]>`. Now returns `Promise<CurlInvocationResult>` — the same argument array plus the service's transport preference. The transport comes from `service.transport ?? 'curl'` (line 157). Passthrough/unknown-service cases default to `'curl'`.

This is the key change that lets callers (CLI curl command, gateway) decide which transport to use without duplicating the service lookup.

#### `src/cliCommands.ts`

**`latchkey curl` command** (lines 774-818): After `prepareCurlInvocation`, checks `invocation.transport`. If `'cycletls'`:
1. Dynamically imports `cycleTlsTransport`
2. Parses the injected curl args into HTTP request
3. Calls CycleTLS
4. Writes response body to stdout
5. Cleans up the Go binary
6. Exits 0

If `'curl'` (default): existing behavior unchanged — spawns curl with inherited stdio.

#### `src/gateway/gatewayEndpoint.ts`

**Gateway proxy** (lines 369-390): Same pattern. If transport is `'cycletls'`:
1. Parses injected curl args to HTTP (including request body from stdin)
2. Calls CycleTLS
3. Forwards response headers (filtering hop-by-hop) and body directly to the client
4. No temp files needed — CycleTLS returns structured data, unlike curl which needs `-D` for header capture

If `'curl'`: existing behavior unchanged — spawns curl with header dump file.

#### `package.json`

Added `cycletls@^2.0.5` under `optionalDependencies`. Users who need it run `npm install cycletls`. Users who don't need it are unaffected — the dynamic import is wrapped in error handling.

---

## Known Gap

DoorDash's custom `checkApiCredentials` override (in `doordash.ts`) still uses `runCaptured` (curl) instead of CycleTLS. This means `latchkey auth list` will still show DoorDash credentials as `invalid` because curl gets 403'd. The fix is to update that override to use CycleTLS — same `parseCurlArgsToHttp` + `cycleTlsRequest` pattern used in the CLI and gateway.

The `latchkey curl` and gateway paths are fully wired to CycleTLS for DoorDash.

## Test Impact

All 523 existing tests pass. No test changes needed — the `transport` property is optional so existing mock Service objects are unaffected, and CycleTLS code paths are only triggered when `transport === 'cycletls'`.
