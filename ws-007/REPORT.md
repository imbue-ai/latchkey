# ws-007 Report: DoorDash GraphQL Access Testing

## What we did

Tested whether the DoorDash GraphQL consumer query from DATA.md could be executed from CLI. Two approaches tried:

1. **Regular `curl`** — Cloudflare returned HTML challenge page (bot detection via TLS fingerprint). Zero useful data.
2. **`curl_chrome136`** — Bypassed Cloudflare. Got valid JSON response with consumer data (id, name, email).

Also attempted full schema introspection (`__schema` query). Blocked server-side by Apollo Server config, not Cloudflare. Confirmed HICCUPS.md #7 still accurate.

## Key findings

| Approach | Result |
|----------|--------|
| `curl` (system default) | 403 Cloudflare challenge HTML |
| `curl_chrome136` (impersonate) | 200 OK, valid GraphQL JSON |
| Introspection via `curl_chrome136` | Blocked by Apollo Server (`GRAPHQL_VALIDATION_FAILED`) |

## What was needed to make it work

- **curl_chrome136** binary at `/Users/bowei/code/latchkey/ws-002/tools/curl_chrome136` — TLS fingerprint impersonation required to pass Cloudflare
- Auth cookies from DATA.md still valid (JWT `ddweb_token` + `csrf_token` + `cf_clearance`)
- `operationName` + `variables` format worked fine here (contradicts HICCUPS.md #1, but that issue may be curl-specific or payload-specific)

## Recommendations for next time

1. **Always use `curl_chrome136`** (or equivalent impersonate binary) for DoorDash requests. Regular curl will never work — Cloudflare blocks on TLS fingerprint.
2. **Schema discovery remains manual** — introspection disabled server-side. Use error message probing (HICCUPS.md #17) or reference existing query files in ws-005/ws-006.
3. **Cookie expiry** — JWT in `ddweb_token` has `exp: 1779041100` (~3 days from capture). Re-login needed after expiry. `cf_clearance` may expire sooner.
4. **Latchkey has a `doordash` service** — could potentially handle cookie/auth injection automatically via `npx latchkey curl`. Not tested this session but worth exploring to avoid hardcoding cookies.

## Could have done better

- Could have tried `npx latchkey curl` first — it's designed exactly for this (credential injection + possibly TLS handling). Would avoid manually copying cookies from DATA.md.
- Session was very short (2 queries). With more time, could have probed mutation names and mapped available operations via error-message technique from HICCUPS.md #17.
