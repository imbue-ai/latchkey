# DoorDash Service for Latchkey — Report

## What Was Done

Added `doordash` service: `latchkey auth browser doordash` → browser login → captures `ddweb_token` + `csrf_token` cookies → stores in encrypted credential store. Modeled after Slack service.

**Files:** `src/services/doordash.ts` (new), `src/apiCredentials/serialization.ts`, `src/services/index.ts`, `src/serviceRegistry.ts`, `tests/apiCredentials.test.ts` (all edited). Debug harness in `spike/`.

## Key Technical Issue

Playwright's `response.headers()['set-cookie']` silently drops multi-value Set-Cookie headers. Must use `response.headersArray()`. DoorDash sets both cookies on `www.doordash.com/graphql/postLoginQuery` response, on domain `.doordash.com`. Reading cookies via `context.cookies()` (no URL filter) works.

## Limitations

- `latchkey curl` blocked by DoorDash TLS fingerprinting — cookies only useful for external consumers (doordash-mcp)
- Session expiry unknown; user re-logins when needed

## Process Retro

**What went wrong:** 6 manual logins before getting it right. Should have been 2 (1 for debug harness, 1 final verification). The INSTR.md said to minimize manual QA, but the agent didn't follow through — it should have built the debug harness (saves browser state, eliminates re-logins) after the 2nd failure, not the 5th.

**For next time:**
- Budget manual interactions upfront in the plan ("human logs in max N times")
- Build debug harness FIRST, before any service code
- Use `response.headersArray()` not `response.headers()` for Set-Cookie — consider adding a shared helper
- Slack service's `getApiCredentialsFromResponse` avoids `response.headers()` for cookies — read existing code more carefully before implementing
