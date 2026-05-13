# Blocker: DoorDash TLS Fingerprinting

## Problem

DoorDash uses Cloudflare with JA3 TLS fingerprinting. Plain curl gets 403 on every endpoint (`www.doordash.com`, `identity.doordash.com`). This blocks both auth validation and `latchkey curl` for DoorDash.

Browser login works fine — Playwright uses a real Chrome, so cookies (`ddweb_token`, `csrf_token`) get captured and stored. But stored credentials show `invalid` because the curl-based check can't reach DoorDash.

## What fails

1. **Auth validation** (`checkApiCredentials`): shells out to curl → 403.
2. **`latchkey curl`**: shells out to curl → 403.
3. **`credentialCheckCurlArguments`** URL (`consumer-api-gateway.doordash.com/graphql`) doesn't even resolve — wrong endpoint. Real API is `www.doordash.com/graphql/{operation}`. But fixing the URL alone doesn't help because curl still gets 403.

## Root cause

Latchkey's entire HTTP layer is `child_process.spawn('curl', ...)`. Cloudflare fingerprints curl's TLS handshake (JA3 hash) and rejects it. No amount of header spoofing (User-Agent, sec-ch-ua, etc.) fixes this — it's at the TLS level.

## Why CycleTLS would help

CycleTLS is a Go-based HTTP client that impersonates browser TLS fingerprints (Chrome JA3). The doordash-mcp project (`~/code/doordash-mcp/ws-005/test.mjs`) uses it successfully for all DoorDash API calls.

If latchkey could use CycleTLS (or curl-impersonate) as an alternative transport, both auth validation and `latchkey curl` would work for DoorDash.

## Options

1. **CycleTLS integration**: Add CycleTLS as an optional transport alongside curl. Services like DoorDash could opt into it.
2. **curl-impersonate support**: Allow `CONFIG.curlCommand` to point at `curl_chrome116` (curl-impersonate binary). Requires user to install it.
3. **Skip validation only**: Override `checkApiCredentials` to return `Unknown` for DoorDash. Credentials stay stored for external consumers (doordash-mcp). `latchkey curl` still won't work.
4. **Gateway with CycleTLS**: The `latchkey gateway` proxy could use CycleTLS internally instead of spawning curl, while `latchkey curl` stays curl-based.

## Interim workaround

The stored cookies work. External consumers (doordash-mcp) that use CycleTLS can read them from latchkey's credential store and make DoorDash API calls. `latchkey curl` just can't be the transport for DoorDash.
