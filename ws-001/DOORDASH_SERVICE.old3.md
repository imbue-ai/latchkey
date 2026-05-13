what do you plan to do if the playwright login fails on first try?

you might want to debug using cdp, or if that still fails, screenshot, and then if you still get stuck there you may have to escalate to manual help as a last resort.
--

# DoorDash Service for Latchkey

## Goal

`latchkey auth login doordash` → browser opens → user logs in → `ddweb_token` + `csrf_token` cookies captured and stored. Modeled after Slack service (cookie-based credentials + SimpleServiceSession).

## Complexity: Low-Medium (~140 lines, ~2 hours)

## Implementation

| Step | What | Files |
|------|------|-------|
| 1 | `DoorDashApiCredentials` class (Zod schema, cookie injection via `-H "Cookie: ..."`) | New: `src/services/doordash.ts` |
| 2 | `Doordash` service + `DoorDashServiceSession` extending `SimpleServiceSession` — capture cookies from Playwright `context.cookies()` after login-complete redirect | Same file |
| 3 | Wire into serialization union + deserialize/serialize switch | Edit: `src/apiCredentials/serialization.ts` |
| 4 | Register service | Edit: `src/services/index.ts`, `src/serviceRegistry.ts` |

## Execution — Code First, Human Last

**Phase 1: Implement + automated tests (~1.5 hr, no human)**
- Write service code (Slack as template)
- Write Playwright test that navigates to DoorDash login page, confirms page loads without bot-block
- Write unit tests for credential serialization/injection
- Test `latchkey auth status doordash` shows "missing" (confirms wiring)

**Phase 2: Single human pass (~20 min)**
- Human runs `latchkey auth login doordash`, logs in once
- Confirm cookies captured, `auth status` shows valid
- Try `latchkey curl` against DoorDash GraphQL — if blocked by TLS fingerprinting, that's acceptable (cookies still usable by external tools like doordash-mcp)

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| TLS fingerprinting blocks `latchkey curl` | High | Phase 2 tests this. Cookies still valuable for doordash-mcp even if curl blocked. Login (Playwright = real browser) unaffected. |
| Playwright automation detection on login | Medium | `headless: false` + Playwright stealth. Phase 1 automated test catches this early. |
| Cookie names change | Low | Thin surface area — two string constants to update. |
| Session expiry unknown | Low | `isExpired()` returns `undefined`; user re-logins when needed. |

## Not Needed

No MFA code (browser handles it), no CycleTLS, no GraphQL client, no programmatic login flow, no session persistence (latchkey encrypted storage handles it).
