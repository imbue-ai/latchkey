we should have planned out how many times the human would need to manually auth in, upfront.

the INSTR.md had some messaging to that effect but clearly it wasn't communicated effiectively.

adding debug harness and more tools around the 2nd or 3rd time asking the human to login, instead of the 10th and 12th, would have been better.

--

# DoorDash Service for Latchkey — Implementation Report

## What Was Done

Added a `doordash` service to latchkey that captures `ddweb_token` + `csrf_token` session cookies via Playwright browser login. User runs `latchkey auth browser doordash`, logs into DoorDash in the browser, and credentials are automatically extracted and stored in latchkey's encrypted credential store.

### Files Created
- `src/services/doordash.ts` — `DoorDashApiCredentials` (Zod schema, cookie injection), `DoorDashServiceSession` (login detection + cookie extraction), `Doordash` service class

### Files Modified
- `src/apiCredentials/serialization.ts` — wired `DoorDashApiCredentialsSchema` into discriminated union + serialize/deserialize
- `src/services/index.ts` — exported `DOORDASH`
- `src/serviceRegistry.ts` — registered in `SERVICE_REGISTRY`
- `tests/apiCredentials.test.ts` — added credential injection + serialization roundtrip tests

### Files Created (debug, not shipped)
- `spike/doordash-debug-harness.ts` — standalone Playwright script that saves/reloads browser state for iterating without re-login
- `spike/doordash-state.json` — saved browser state

## Hiccups & What Made This Hard

### 1. Playwright `response.headers()` silently drops Set-Cookie (biggest blocker)

`response.headers()['set-cookie']` returns undefined/empty for multi-value Set-Cookie headers in Playwright. This is underdocumented. The fix is to use `response.headersArray()` which returns each Set-Cookie as a separate entry. This cost ~4 failed login attempts before the debug harness identified it.

**Recommendation:** Any future service that detects login completion via Set-Cookie headers MUST use `headersArray()`, not `headers()`. Consider adding a helper in `playwrightUtils.ts` like `getSetCookieValues(response)` to avoid this trap.

### 2. Login completion URL was wrong

Initial assumption: login redirects to `/home`. Reality: login redirects to `/?state=none&code=...` → `/post-login/` → then JS fires `postLoginQuery` GraphQL mutation which sets the actual cookies. The correct completion signal is detecting `ddweb_token` in the Set-Cookie of the `www.doordash.com/graphql/postLoginQuery` response.

**Recommendation:** Don't guess the post-login URL. Build a debug harness first that logs all responses/cookies, then implement the detection.

### 3. Cookie domain mismatch

`context.cookies('https://www.doordash.com')` missed cookies set on `.doordash.com` (note leading dot = all subdomains). Fix: call `context.cookies()` with no URL filter.

**Recommendation:** Always use `context.cookies()` without URL filter when extracting cookies in `finalizeCredentials`, then filter by name.

### 4. Too many manual login iterations

First 4 attempts were guess-and-check: change code → rebuild → ask user to log in → fail → repeat. Wasted ~30 min of human time.

**Recommendation:** Build a debug harness (like `spike/doordash-debug-harness.ts`) BEFORE the first login attempt. The harness should:
- Save browser state via `context.storageState()` after login
- Reload state on subsequent runs (skip login)
- Log all Set-Cookie headers via both `headers()` and `headersArray()` to surface discrepancies
- Log all cookies from `context.cookies()` with domain info

This would have reduced human logins from 6 to 1.

## What Worked Well

- Slack service was an excellent template for the credential type + serialization wiring
- Latchkey's `ServiceSession` abstraction is clean — just implement `onResponse`, `isLoginComplete`, `finalizeCredentials`
- The `LATCHKEY_DEBUG=1` mode (keeps browser open on failure, saves screenshots) was useful once we got to the right debugging stage

## Known Limitations

- **`latchkey curl` doesn't work with DoorDash** — curl gets connection refused / TLS fingerprint blocked. Cookies are only useful for external consumers (doordash-mcp, custom scripts). Credential check reports "invalid" for this reason.
- **Session expiry unknown** — `isExpired()` returns `undefined`. Users must re-login when sessions expire.

## Could Have Done Better

1. **Debug harness first, implementation second.** The plan doc correctly identified testing early as important, but in practice I jumped to implementation and iterated via manual logins. Should have built the harness as step 1.

2. **Read Playwright docs on `response.headers()` vs `headersArray()` upfront.** The Slack service uses `response.text()` (async) and `request.allHeaders()`, not `response.headers()['set-cookie']`. If I'd noticed Slack avoids `response.headers()` for cookies, I might have avoided the trap.

3. **Could use `SimpleServiceSession` with `context.cookies()` polling instead of Set-Cookie detection.** An alternative approach: detect login completion by URL change (e.g., arriving at doordash.com after leaving identity.doordash.com), then poll `context.cookies()` in `finalizeCredentials` with a short wait. This would bypass the Set-Cookie header issue entirely. The harness proved this works (polls every 2s, found the cookie after ~24s).
