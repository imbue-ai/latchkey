# MR Split Plan

## Current state

Branch `bowei/doordash` has 13 commits on top of `main` with 74 files changed. Most are workspace/spike files that should NOT be submitted. The real source changes are 12 files.

E2E tested and passing: fresh login, relogin, API calls all work.

## Proposed PRs

### PR 1: CycleTLS transport support

Adds infrastructure for services behind Cloudflare TLS fingerprinting to use CycleTLS (Go-based HTTP client with Chrome JA3 fingerprint) instead of curl.

**Files:**
- `package.json` — add `cycletls` as optional dependency
- `src/cycletls.d.ts` — type declarations for cycletls
- `src/cycleTlsTransport.ts` — transport implementation (lazy-load, request/close)
- `src/services/core/base.ts` — `transport` property on Service, cycletls path in `checkApiCredentials`, `prepareContext` hook on ServiceSession
- `src/curlInjection.ts` — new `CurlInvocationResult` type (adds transport field), plumb transport through
- `src/cliCommands.ts` — cycletls execution path in `latchkey curl`
- `src/gateway/gatewayEndpoint.ts` — cycletls execution path in gateway proxy

**Note:** `prepareContext` hook is technically a DoorDash need, but it's a general-purpose extension point on the base class. Makes sense in this PR since it touches `base.ts` anyway. Could also go in PR 2 — open to either.

### PR 2: DoorDash service (depends on PR 1)

Adds DoorDash as a supported service with browser-based cookie login.

**Files:**
- `src/services/doordash.ts` — service + credential class + session (prepareContext cookie clearing, dual login detection, GraphQL credential check)
- `src/services/index.ts` — export DOORDASH
- `src/serviceRegistry.ts` — register DOORDASH
- `src/apiCredentials/serialization.ts` — add DoorDash schema + ser/deser
- `tests/apiCredentials.test.ts` — DoorDash credential tests + serialization roundtrip

### Files NOT in either PR

These stay on the branch (or get cleaned up separately):
- `ws-001/` through `ws-005/` — workspace instruction/status/report files
- `spike/` — debug harnesses
- `ws-002/tools/` — curl-impersonate binaries

## Mechanics

**Option A: Stacked PRs**
1. Create branch `bowei/cycletls-transport` from `main`, cherry-pick/recreate PR 1 changes
2. Create branch `bowei/doordash-service` from `bowei/cycletls-transport`, cherry-pick/recreate PR 2 changes
3. PR 1 targets `main`, PR 2 targets `bowei/cycletls-transport` (rebase onto main after PR 1 merges)

**Option B: Independent PRs**
1. PR 1 same as above
2. PR 2 includes the `prepareContext` hook (move it from PR 1) and the base.ts transport property, making it self-contained
3. Both target `main` independently

**Option C: Single PR**
Just one PR with all 12 source files. Simpler, but bigger review.

## CycleTLS findings

Tested CycleTLS for DoorDash — **does not work** (403 from Cloudflare). curl-impersonate works.
Also found cycletls Go binary hangs the process after `auth list`.

Full details: [CYCLETLS_FINDINGS.md](./CYCLETLS_FINDINGS.md)

This means:
- DoorDash does NOT use `transport = 'cycletls'`, relies on `LATCHKEY_CURL` env var with curl-impersonate
- CycleTLS infra (PR 1) is still valid for other services, but has no consumer yet
- Question: should PR 1 (cycletls infra) still be submitted now, or deferred until there's a service that needs it?

## Open questions

1. Stacked, independent, or single PR?
2. Should `prepareContext` go in PR 1 (cycletls infra) or PR 2 (doordash)?
3. The `ws-*` and `spike/` dirs — add to `.gitignore`? Delete from branch? Leave for later?
4. Given cycletls doesn't work for DoorDash, should PR 1 (cycletls infra) be submitted now or deferred? If deferred, PR 2 becomes self-contained (just needs `prepareContext` hook moved into it).
