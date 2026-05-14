# CycleTLS vs curl-impersonate: DoorDash TLS Fingerprinting

## Test date: 2026-05-14

## Context

DoorDash is behind Cloudflare with TLS fingerprinting (JA3). Plain curl gets 403. Two options for bypassing: CycleTLS (Go-based, npm package) and curl-impersonate (standalone binary).

## CycleTLS (npm `cycletls@^2.0.5`)

**Result: DOES NOT WORK for DoorDash. Gets 403.**

Tested with hardcoded Chrome JA3 string:
```
771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,
0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513-21,29-23-24,0
```

Response: HTTP 403, body undefined. Cloudflare still blocks it.

**Additional issue:** The CycleTLS Go binary (`node_modules/cycletls/dist/index-mac-arm64`) spawns as a subprocess and doesn't exit cleanly after `auth list` completes. Causes the process to hang indefinitely. Would need explicit `closeCycleTls()` calls at every exit path, which `auth list` doesn't do.

## curl-impersonate (`curl_chrome136`)

**Result: WORKS. Gets 200 with valid data.**

Binary from lexiforest/curl-impersonate. Used via `LATCHKEY_CURL` env var (drop-in curl replacement).

Tested:
- `auth list` → doordash: valid
- `latchkey curl` with GraphQL query → returns order history
- Fresh login + relogin → both work

## Why CycleTLS fails

Likely explanation: CycleTLS only spoofs the JA3 fingerprint (ClientHello cipher suites + extensions). Modern Cloudflare also checks:
- JA4 fingerprint (includes ALPN, SNI ordering)
- HTTP/2 fingerprint (SETTINGS frame, priority frames)
- TLS extension ordering and values

curl-impersonate does a deeper impersonation — it's a patched libcurl that matches Chrome's full TLS and HTTP/2 behavior, not just the cipher suite list.

## Recommendation

Keep `LATCHKEY_CURL=path/to/curl_chrome136` as the DoorDash solution. Don't set `transport = 'cycletls'` on the DoorDash service. The CycleTLS infrastructure in the codebase is still useful for other services with less aggressive fingerprinting, but DoorDash isn't one of them.

The cycletls Go binary hang issue should also be fixed before cycletls is used for any service — need `closeCycleTls()` in the `auth list` exit path.
