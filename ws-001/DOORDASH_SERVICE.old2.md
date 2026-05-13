first, doc is too long, a more concise ver is better. aim for <50 lines.

2. Don't use human testing first -- use only as last resort. for instance phase 0, we can write playwright code first and simply ask the human to review the flow if something seems off. Manual QA is more expensive than testing using code, our only manual QA is our PMs who are very busy. basically coding with early tests < coding < coding with lots of manual interruption.

--

# DoorDash Service for Latchkey — Feasibility & Complexity

## Goal

Add a DoorDash service to latchkey so users can `latchkey auth login doordash` via browser, capturing the `ddweb_token` session cookie (and related cookies) needed for DoorDash's internal GraphQL API.

## Verdict: Low-Medium Complexity

The login/cookie-capture part maps cleanly onto existing latchkey patterns (especially Slack, which also uses custom cookie-based credentials). The main risk is whether `latchkey curl` with regular curl will work against DoorDash's bot detection.

---

## Execution Plan — Test-First Sequencing

The biggest unknowns are whether (a) Playwright can capture DoorDash cookies and (b) curl can use them without getting bot-blocked. We test both **before** writing production code.

### Phase 0: Manual Recon (human, ~20 min)

Goal: Confirm cookie names and capture mechanics before writing any code.

1. Open Chrome DevTools → Network tab → Preserve log
2. Go to `https://www.doordash.com/consumer/login/`, log in normally
3. Record:
   - Which response sets `ddweb_token` (look at `Set-Cookie` headers)
   - Which response sets `csrf_token`
   - The final URL after login completes (redirect target)
   - Any other cookies that appear required
4. Copy cookie values. Test manually:
   ```
   curl -s -H "Cookie: ddweb_token=<value>; csrf_token=<value>" \
     -H "Content-Type: application/json" \
     -d '{"query":"{ currentUser { id firstName } }"}' \
     https://consumer-api-gateway.doordash.com/graphql
   ```
5. If curl gets blocked (403/Cloudflare challenge), try with `--compressed` and Chrome user-agent header

**Decision gate:** If manual curl works → proceed to Phase 1. If blocked → `latchkey curl` won't work either; scope down to login-and-export-cookie only (still useful for doordash-mcp consumers). Either way, proceed — the cookie capture is valuable.

### Phase 1: Playwright Spike (human + code, ~30 min)

Goal: Confirm Playwright can capture cookies during DoorDash login.

Write a minimal standalone script (not wired into latchkey yet):

```typescript
// spike/doordash-login-test.ts
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

context.on('response', async (response) => {
  const url = response.url();
  const headers = response.headers();
  const setCookie = headers['set-cookie'] ?? '';
  if (setCookie.includes('ddweb_token') || setCookie.includes('csrf_token')) {
    console.log(`[SET-COOKIE] ${url}`);
    console.log(setCookie);
  }
});

await page.goto('https://www.doordash.com/consumer/login/');
console.log('Log in manually in the browser...');
// Wait for user to complete login
await page.waitForURL('**/home/**', { timeout: 120_000 });

const cookies = await context.cookies();
for (const c of cookies) {
  if (c.name === 'ddweb_token' || c.name === 'csrf_token') {
    console.log(`${c.name} = ${c.value.slice(0, 20)}...`);
  }
}
await browser.close();
```

Human runs this, logs in, confirms cookies are captured. This tests:
- Does DoorDash login page render in Playwright's Chromium?
- Does it block headless/automation detection? (launch with `headless: false` so it's a real window)
- Can we read cookies from context after login?
- Which URL pattern indicates login completion?

**Decision gate:** If cookies captured → Phase 2. If DoorDash blocks Playwright Chromium → need to investigate stealth plugins or alternative approach (bigger scope change).

### Phase 2: Implement Service (~45 min, no human needed)

Only reached after both gates pass. Now write production code with known-good parameters from Phase 0 and 1:

1. `src/services/doordash.ts` — credential type + service + session (~120 lines)
2. `src/apiCredentials/serialization.ts` — wire credential type
3. `src/services/index.ts` + `src/serviceRegistry.ts` — register

### Phase 3: E2E Verification (human, ~20 min)

Human runs the full latchkey flow end-to-end:

1. **Login test:**
   ```
   latchkey auth login doordash
   ```
   - Browser opens → human logs in → credentials captured and stored
   - Confirm: `latchkey auth status doordash` shows valid/stored

2. **Credential check test:**
   ```
   latchkey auth check doordash
   ```
   - Hits DoorDash API with stored cookies
   - Confirm: returns Valid (or Unknown if we skipped credential check)

3. **Curl test** (if Phase 0 showed curl works):
   ```
   latchkey curl -X POST \
     -H "Content-Type: application/json" \
     -d '{"query":"{ currentUser { id } }"}' \
     https://consumer-api-gateway.doordash.com/graphql
   ```
   - Confirm: returns user data, not Cloudflare block

4. **Persistence test:**
   - Restart terminal
   - Re-run curl test without re-logging in
   - Confirm: credentials loaded from encrypted storage

5. **Edge case: expired session**
   - Wait or manually invalidate cookies
   - Confirm: latchkey reports appropriate error, re-login works

### Timeline Summary

| Phase | Who | Duration | Blocker? |
|-------|-----|:---:|:---:|
| 0 — Manual recon | Human | ~20 min | **Yes** — determines if curl works |
| 1 — Playwright spike | Human + script | ~30 min | **Yes** — determines if login capture works |
| 2 — Implement service | Code only | ~45 min | No |
| 3 — E2E verification | Human | ~20 min | No (fix-and-retry) |
| **Total** | | **~2 hours** | |

Phase 0 and 1 can run in parallel (one person does manual recon while another preps the Playwright script). Phase 2 is blocked on Phase 1. Phase 3 is blocked on Phase 2.

**Worst case** (both gates fail): ~1 hour spent, clear answer on what's blocking, no wasted implementation code.

**Happy path**: ~2 hours to working `latchkey auth login doordash`.

---

## What Needs to Be Implemented (Phase 2 Details)

### 1. DoorDash Credential Type (~40 lines)

New `DoorDashApiCredentials` class, modeled directly after `SlackApiCredentials`.

**Fields:**
- `ddwebToken` — the primary session cookie
- `csrfToken` — needed for mutating GraphQL calls

**Injection:** Adds `-H "Cookie: ddweb_token=...; csrf_token=..."` to curl args.

**Files touched:**
- New: `src/services/doordash.ts` (credential class + Zod schema)
- Edit: `src/apiCredentials/serialization.ts` (add to union schema + deserialize/serialize)

**Effort: Small.** Slack is an exact template.

### 2. DoorDash Service + Session (~80 lines)

New `Doordash` service class extending `Service`, with a `SimpleServiceSession` subclass.

**Service definition:**
```
name: 'doordash'
displayName: 'DoorDash'
baseApiUrls: ['https://consumer-api-gateway.doordash.com/']
loginUrl: 'https://www.doordash.com/consumer/login/'
```

**Session (cookie capture):**
The `SimpleServiceSession` approach: open browser to DoorDash login page, user enters email/password (and MFA if prompted) manually in the real browser. After login completes, read cookies from Playwright's browser context (`context.cookies()`) and extract `ddweb_token` + `csrf_token`.

Two possible interception strategies (Phase 1 spike determines which):
- **Option A:** Watch `Set-Cookie` response headers for `ddweb_token` (like Slack watches for `d=` cookie)
- **Option B:** Wait for login-complete URL redirect, then read all cookies from `context.cookies()`. May need `BrowserFollowupServiceSession` instead of `SimpleServiceSession`.

**Files touched:**
- New: `src/services/doordash.ts` (service class + session class, combined with credentials)
- Edit: `src/services/index.ts` (export `DOORDASH`)
- Edit: `src/serviceRegistry.ts` (add `DOORDASH` to registry)

### 3. Registration / Serialization Wiring (~15 lines)

- Add `DoorDashApiCredentialsSchema` to the discriminated union in `serialization.ts`
- Add `deserialize`/`serialize` cases
- Export from `services/index.ts`

---

## Risks & Open Questions

### Risk 1: TLS Fingerprinting / Bot Detection (HIGH)

DoorDash uses Cloudflare bot detection. The doordash-mcp project uses **CycleTLS** to spoof Chrome's JA3 TLS fingerprint because regular HTTP clients get blocked.

**Impact on login:** None. Latchkey uses Playwright (real Chromium browser), so login will work fine.

**Impact on `latchkey curl`:** Regular curl has a different TLS fingerprint than Chrome. DoorDash may reject API requests from plain curl even with valid cookies. This would make the captured cookies usable only outside latchkey (e.g., passed to the doordash-mcp tool or a custom client), not via `latchkey curl`.

**Mitigations:**
- Phase 0 manual test resolves this question before any code is written
- If blocked: cookies still valuable for non-curl consumers (doordash-mcp, custom scripts)
- If user only needs the cookie value (stated goal), this risk doesn't matter

### Risk 2: Playwright Automation Detection (MEDIUM)

DoorDash may detect Playwright's Chromium as automated. Some sites check `navigator.webdriver` or Chromium automation flags.

**Mitigations:**
- Phase 1 spike resolves this before implementation
- Playwright launched with `headless: false` (real window) reduces detection
- Latchkey's `playwrightUtils.ts` may already handle common detection evasion

### Risk 3: Login URL & Auth Flow Fragility (MEDIUM)

DoorDash's identity flow uses internal endpoints that could change. The browser-based approach is resilient because the user sees and interacts with whatever UI DoorDash presents. But the cookie extraction logic depends on specific cookie names (`ddweb_token`, `csrf_token`) which could change.

### Risk 4: Session Expiry (LOW)

No clear expiry signal in DoorDash cookies. `isExpired()` returns `undefined`. Users re-login when requests fail.

### Risk 5: Credential Check Endpoint (LOW)

Need a lightweight DoorDash API call to validate credentials. May need specific headers (`x-experience-id`, `x-channel-id`). If credential check is too complex, return `Unknown` status — acceptable for v1.

---

## What's NOT Needed

- **No MFA handling code** — browser login means user completes MFA naturally
- **No CycleTLS dependency** — Playwright handles browser session; curl handles API calls
- **No GraphQL client** — latchkey just injects cookies into curl, user provides the query
- **No session persistence logic** — latchkey's encrypted credential storage handles this
- **No programmatic login flow** — the whole identity.doordash.com/auth POST chain from doordash-mcp is unnecessary; we let the user log in via real browser
