# DoorDash Service — Auth Validation & E2E Curl Fix Report

## What Was Done

Fixed DoorDash auth validation and got `latchkey curl` working e2e for DoorDash GraphQL API calls. Browser login was already working (ws-001); this session made the stored credentials actually usable.

### Changes

**`src/services/doordash.ts`** (bulk of work):
- Fixed `baseApiUrls`: `consumer-api-gateway.doordash.com` (didn't even resolve) → `www.doordash.com/graphql`
- Fixed `credentialCheckCurlArguments`: valid GraphQL query (`consumer { id email }`) at correct URL
- Added `checkApiCredentials` override: DoorDash returns 200 with null fields for unauthenticated users, so check response body, not HTTP status
- Added required DoorDash headers to `injectIntoCurlCall`: `x-csrftoken`, `x-channel-id`, `x-experience-id`, `Origin`, `Referer`
- Added `ddweb_session_id` to credential schema — DoorDash requires 3 cookies, not 2 (not documented in cheatsheet)
- Fixed Service Worker crash in cookie-polling fallback (`response.frame()` throws on SW requests)

**`tests/apiCredentials.test.ts`**: Updated for new headers and 3-arg constructor.

**`ws-002/tools/`**: Downloaded curl-impersonate v1.5.6 (lexiforest fork, arm64-macos). `curl_chrome136` bypasses Cloudflare TLS fingerprinting.

### Verified Working

- `latchkey auth list` → doordash `credentialStatus: valid`
- Order history, list carts, store lookup, add/remove cart items — all working e2e
- Browser login with `prepareContext` cookie clearing (ws-004 fix) — repeat logins work

## Hiccups

1. **`consumer-api-gateway.doordash.com` doesn't exist.** ws-001 used this URL without testing. Wasted time before discovering it doesn't resolve.

2. **Plain curl gets 403.** Cloudflare TLS fingerprinting blocks curl. Had to find and download curl-impersonate. `curl_chrome136` works; older fingerprints (chrome116) don't.

3. **DoorDash returns 200 for unauthenticated requests** with null data fields. The standard `checkApiCredentials` (HTTP status check) always said "valid". Needed body inspection.

4. **`ddweb_session_id` cookie required.** Cheatsheet only documented `ddweb_token` + `csrf_token`. Took binary search across 57 cookies to find the third required one.

5. **`transport = 'cycletls'`** from in-progress CycleTLS work broke all DoorDash curl commands (cycletls npm package not installed). Had to remove it.

6. **Service Worker crash.** Playwright's `response.frame()` throws on Service Worker requests. The cookie-polling fallback in `onResponse` hit this on DoorDash's SW responses.

7. **addCartItem clobbers existing orders** when called with an existing cartId. This is a DoorDash API behavior — not a latchkey bug, but surprised us during testing. Lost a Caesar Wrap, had to restore.

## Recommendations

1. **Always test the credential check URL resolves** before committing a new service. A simple `curl -s -o /dev/null -w '%{http_code}' <url>` in the PR checklist would catch this.

2. **curl-impersonate should be a documented option.** `LATCHKEY_CURL` env var already supports drop-in replacements, but nothing in docs mentions curl-impersonate. For any Cloudflare-protected service, this is the path until CycleTLS lands.

3. **The cheatsheet was incomplete for latchkey's needs.** It was written for CycleTLS consumers. Missing: which cookies are required (3 not 2), that 200 doesn't mean authenticated, that `operationName`+`variables` returns 400 on some endpoints. A curl-focused addendum would help.

4. **Body-based credential checks should be a pattern.** Other APIs may also return 200 for unauthenticated requests. Consider adding a `checkApiCredentialsFromBody` helper or documenting the override pattern for service authors.

5. **`response.frame()` is unsafe in `onResponse`.** Any service using the cookie-polling fallback pattern must wrap `response.frame()` in try/catch for Service Worker requests. Consider adding a helper like `safeGetContext(response)` to avoid this footgun.

6. **The ws-005 cheatsheet should be updated** to note `ddweb_session_id` as a required cookie and the 200-with-nulls auth behavior.
