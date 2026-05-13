let's include some plans for e2e verification - probably will need to involve a human to test.

how do we intend to sequence that and how long will it take?

best to test earlier so as to find out potential blockers earlier.

--

# DoorDash Service for Latchkey — Feasibility & Complexity

## Goal

Add a DoorDash service to latchkey so users can `latchkey auth login doordash` via browser, capturing the `ddweb_token` session cookie (and related cookies) needed for DoorDash's internal GraphQL API.

## Verdict: Low-Medium Complexity

The login/cookie-capture part maps cleanly onto existing latchkey patterns (especially Slack, which also uses custom cookie-based credentials). The main risk is whether `latchkey curl` with regular curl will work against DoorDash's bot detection.

---

## What Needs to Be Implemented

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
loginUrl: 'https://identity.doordash.com/auth?client_id=...' (or 'https://www.doordash.com/consumer/login/')
```

**Session (cookie capture):**
The `SimpleServiceSession` approach: open browser to DoorDash login page, user enters email/password (and MFA if prompted) manually in the real browser. Watch network responses for:
- Requests to `*.doordash.com` that carry `ddweb_token` in `Set-Cookie` or `Cookie` headers
- Extract `ddweb_token` and `csrf_token` from cookie headers

This is the same pattern Slack uses to capture `d=` cookie + `api_token`.

**Files touched:**
- New: `src/services/doordash.ts` (service class + session class, combined with credentials)
- Edit: `src/services/index.ts` (export `DOORDASH`)
- Edit: `src/serviceRegistry.ts` (add `DOORDASH` to registry)

**Effort: Small-Medium.** The tricky bit is identifying which response carries the final cookies. May need to observe the full login flow in browser DevTools to find the right interception point.

### 3. Registration / Serialization Wiring (~15 lines)

- Add `DoorDashApiCredentialsSchema` to the discriminated union in `serialization.ts`
- Add `deserialize`/`serialize` cases
- Export from `services/index.ts`

**Effort: Trivial.** Mechanical wiring.

---

## Risks & Open Questions

### Risk 1: TLS Fingerprinting / Bot Detection (HIGH)

DoorDash uses Cloudflare bot detection. The doordash-mcp project uses **CycleTLS** to spoof Chrome's JA3 TLS fingerprint because regular HTTP clients get blocked.

**Impact on login:** None. Latchkey uses Playwright (real Chromium browser), so login will work fine.

**Impact on `latchkey curl`:** Regular curl has a different TLS fingerprint than Chrome. DoorDash may reject API requests from plain curl even with valid cookies. This would make the captured cookies usable only outside latchkey (e.g., passed to the doordash-mcp tool or a custom client), not via `latchkey curl`.

**Mitigations:**
- Test with `curl --tlsv1.2 --ciphers ...` to see if cipher suite matters
- If blocked: the cookies are still valuable for non-curl consumers (doordash-mcp, custom scripts). `latchkey auth login doordash` + read credentials from encrypted storage.
- If user only needs the cookie value (stated goal), this risk doesn't matter

### Risk 2: Login URL & Auth Flow Fragility (MEDIUM)

DoorDash's identity flow uses internal endpoints that could change. The browser-based approach is more resilient than programmatic login because the user sees and interacts with whatever UI DoorDash presents. But the cookie extraction logic depends on specific cookie names (`ddweb_token`, `csrf_token`) which could change.

### Risk 3: Session Expiry (LOW)

No clear expiry signal in DoorDash cookies. Sessions likely expire after some period. `isExpired()` would return `undefined`. Users would need to re-login when requests start failing.

### Risk 4: Credential Check Endpoint (LOW)

Need a lightweight DoorDash API call to validate credentials. Something like:
```
POST https://consumer-api-gateway.doordash.com/graphql
Body: {"query": "{ currentUser { id } }"}
```
May need specific headers (`x-experience-id`, `x-channel-id`). If credential check is too complex, can return `Unknown` status.

---

## Estimate

| Component | Lines of Code | Effort |
|-----------|:---:|:---:|
| Credential type + Zod schema | ~40 | 15 min |
| Service class + session | ~80 | 30-60 min |
| Serialization wiring | ~15 | 10 min |
| Registry + exports | ~5 | 5 min |
| Testing the login flow | — | 30-60 min |
| **Total** | **~140** | **1.5-2.5 hours** |

The bulk of the time is testing — running the actual login flow, finding the right response to intercept, confirming the captured cookies work.

## What's NOT Needed

- **No MFA handling code** — browser login means user completes MFA naturally
- **No CycleTLS dependency** — Playwright handles the browser session; curl handles API calls (may or may not work, see Risk 1)
- **No GraphQL client** — latchkey just injects cookies into curl, user provides the query
- **No session persistence logic** — latchkey's encrypted credential storage handles this
- **No programmatic login flow** — the whole identity.doordash.com/auth POST chain from doordash-mcp is unnecessary; we let the user log in via real browser

## Recommended Approach

1. Create `src/services/doordash.ts` with credential type + service + session (Slack as template)
2. Wire into serialization + registry
3. Test `latchkey auth login doordash` — observe which network response carries the cookies
4. Test `latchkey curl` against DoorDash's GraphQL endpoint to assess bot detection impact
5. If curl is blocked, document that credentials are for external use and add a `latchkey auth show doordash` capability (if not already generic)
