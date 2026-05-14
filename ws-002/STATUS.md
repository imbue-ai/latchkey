# DoorDash Service — Session Status

## Goal (from INSTR.md)

Browser login is working but auth validation is not. Read the doordash-mcp cheatsheet, fix auth validation, test e2e curl commands.

## Done

1. **Fixed `baseApiUrls`** — changed from `consumer-api-gateway.doordash.com/` (doesn't resolve) to `www.doordash.com/graphql`

2. **Fixed `injectIntoCurlCall`** — now injects all required DoorDash headers:
   - `Cookie: ddweb_token=...; csrf_token=...; ddweb_session_id=...`
   - `x-csrftoken: {csrf_token}`
   - `x-channel-id: marketplace`
   - `x-experience-id: doordash`
   - `Origin: https://www.doordash.com`
   - `Referer: https://www.doordash.com/`

3. **Fixed `credentialCheckCurlArguments`** — uses `consumer { id email }` query at `www.doordash.com/graphql/consumer`

4. **Overrode `checkApiCredentials`** — DoorDash returns 200 with null fields for unauthenticated users, so we check response body (consumer.id != null) instead of just HTTP status

5. **Downloaded curl-impersonate** — plain curl gets 403 from Cloudflare TLS fingerprinting. `curl_chrome136` (in `ws-002/tools/`) bypasses it. Use with `LATCHKEY_CURL=/path/to/curl_chrome136`

6. **Discovered `ddweb_session_id` is required** — DoorDash needs 3 cookies, not 2. Added to schema, credential class, and cookie capture in `finalizeCredentials`

7. **Improved login detection** — added fallback cookie polling in `onResponse` for already-logged-in redirects (where `postLoginQuery` never fires)

8. **Removed `transport = 'cycletls'`** — someone else is adding CycleTLS support but `cycletls` npm package isn't installed yet, so it breaks all DoorDash curl commands. Commented out with TODO.

9. **Updated tests** — `apiCredentials.test.ts` updated for new headers and 3-cookie constructor. All pass.

## Stuck on — needs human

Old credentials were cleared (schema changed to require `ddwebSessionId`). Need to re-login:

```
cd /Users/bowei/code/latchkey && LATCHKEY_CURL=/Users/bowei/code/latchkey/ws-002/tools/curl_chrome136 npx latchkey auth browser doordash
```

Must run interactively (not background) so the browser window is visible.

## After re-login, verify

1. `LATCHKEY_CURL=.../curl_chrome136 npx latchkey auth list` — doordash should show `valid`
2. Test order history:
   ```
   LATCHKEY_CURL=.../curl_chrome136 npx latchkey curl -s -X POST \
     -H 'Content-Type: application/json' -H 'Accept: application/json' \
     -d '{"query":"{ getConsumerOrdersWithDetails(offset: 0, limit: 1) { store { name } grandTotal { displayString } submittedAt orders { items { name quantity } } } }"}' \
     'https://www.doordash.com/graphql/getConsumerOrdersWithDetails?operation=getConsumerOrdersWithDetails'
   ```

## Files changed (vs last commit)

- `src/services/doordash.ts` — main changes (URL, headers, session cookie, credential check, login detection)
- `src/services/core/base.ts` — added `prepareContext` hook, `transport` property (from CycleTLS work)
- `tests/apiCredentials.test.ts` — updated for new headers + 3-arg constructor
- `ws-002/tools/` — curl-impersonate binaries (not committed)
- `ws-002/BLOCKER.md` — documents TLS fingerprinting blocker
- `ws-002/STATUS.md` — this file

## Key learnings

- DoorDash Cloudflare blocks at TLS level (JA3 fingerprint), not HTTP headers
- `curl_chrome136` from lexiforest/curl-impersonate works as drop-in via `LATCHKEY_CURL`
- DoorDash returns 200 for unauthenticated GraphQL queries (with null data) — can't check HTTP status alone
- `ddweb_session_id` cookie is required for authenticated requests (not documented in cheatsheet)
- DoorDash rejects `operationName` + `variables` with 400 on some endpoints; inline queries work
