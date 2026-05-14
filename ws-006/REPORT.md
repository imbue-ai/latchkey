# DoorDash Latchkey Curl API — Session Report

## What we did

Manually tested the DoorDash GraphQL API via `latchkey curl` + `curl_chrome136` (TLS fingerprint impersonation). Built a comprehensive cheatsheet of working API queries, documented every pitfall, and mapped the available mutation surface.

### Flows tested end-to-end (16 total)

| # | Flow | Result |
|---|------|--------|
| 1 | List all carts (`listCarts`) | Works |
| 2 | Search restaurants (`autocompleteFacetFeed`) | Works |
| 3 | Consumer identity + default address | Works |
| 3b | Checkout/order preview (`orderCart`) | Works |
| 4 | Store menu (`storepageFeed`) | Works |
| 5 | Item details + options (`itemPage`) | Works (with path workaround) |
| 6 | Create new cart (`addCartItemV2`, cartId="") | Works |
| 7 | Add item to existing cart | Works |
| 8 | Add item with configured options (nestedOptions) | Works |
| 9 | Delete cart (`deleteCart`) | Works |
| 10 | Place order (`createOrderFromCart`) | Works — tested live |
| 11 | Cancel order (`orderCancellation`) | Works — tested live |
| 12 | Remove single item (`removeCartItemV2`) | Works |
| 13 | Update item quantity (`updateCartItemV2`) | Broken — returns null |
| 14 | Order history (`getConsumerOrdersWithDetails`) | Works |
| 15 | Order tracking (`orderTracker`) | Exists but fields undiscoverable |
| 16 | Tip | Not a separate mutation — part of `createOrderFromCart` |

### Live order test
- Created Starbucks cart → added Iced Lemon Loaf ($5.25) → placed order ($10.74 total) → cancelled 8 seconds later → got $5.49 partial refund → verified cancellation in order history via `cancelledAt` field.

## What we had to do special

### 1. TLS fingerprint impersonation
Plain curl gets 403 from Cloudflare. Must use `curl_chrome136` via `LATCHKEY_CURL` env var. All three chrome versions (136, 142, 146) work on most endpoints.

### 2. Inline-only GraphQL queries
Standard `operationName` + `variables` format returns 400 on every endpoint. Must use fully inline queries with no variables. Root cause unknown — CycleTLS in doordash-mcp uses the standard format fine.

### 3. Cloudflare per-path blocking
`/graphql/itemPage` returns 403. Workaround: route through `/graphql/consumer?operation=itemPage`. DoorDash's GraphQL resolver ignores the URL path — only Cloudflare uses it for filtering.

### 4. Schema discovery without introspection
GraphQL introspection is disabled. Discovered mutation names, argument types, and field names via error message probing:
- Wrong field → "Did you mean X?"
- Missing arg → "argument X of type Y is required"
- `__typename` always works to confirm a field exists

This worked well for most types but completely failed on `OrderTrackerResponse` (zero suggestions for ~50 probes).

## Hiccups (20 documented in HICCUPS.md)

Top ones that cost the most time:

1. **operationName+variables → 400** — spent significant time trying headers, apollo client names, etc. before accepting inline-only.
2. **nestedOptions format** — silent `internal-server-error` with no hint about the correct format. Had to query existing cart items to reverse-engineer it.
3. **`orderTracker` field discovery** — ~50 field name probes with zero "Did you mean" suggestions. Likely server-driven UI with unusual names. Dead end without network capture.
4. **Cart garbage collection** — carts disappear or change UUIDs if idle. Multiple test sequences broken by stale cart IDs.
5. **Starbucks required options** — 4+ nested required option groups made it impractical to add drinks via API without full option tree mapping.

## Recommendations for next time

### Do upfront
- **Capture network traffic** from real DoorDash web client (Chrome DevTools → Network tab → filter GraphQL). This would instantly solve the `orderTracker` field mystery and potentially reveal the operationName+variables issue.
- **Have the doordash-mcp queries directory open** as reference from the start. Several hours could have been saved by checking it earlier (e.g. `updateCartItemV2 is broken` comment, `tipAmounts` in createOrderFromCart).
- **Start with quickAdd-eligible items** (like McDonald's water/condiments) for cart testing. Avoids the nestedOptions complexity entirely for initial flow validation.

### Better approaches we could have taken
1. **CycleTLS instead of curl_chrome136** — doordash-mcp's CycleTLS approach supports `operationName` + `variables` format, which is much cleaner than inline queries with triple-escaped JSON strings. If CycleTLS npm package were available in latchkey, it would eliminate the inline-only constraint.
2. **HAR file import** — capturing a HAR file from a real DoorDash session would give exact request/response pairs for every GraphQL operation, including field names for opaque types like `OrderTrackerResponse`.
3. **Existing doordash-mcp as test harness** — rather than raw curl, could have used doordash-mcp's TypeScript API layer directly for initial testing, then only fallen back to curl for latchkey-specific validation.

### Watch out for
- `updateCartItemV2` is broken — always use remove+re-add pattern
- Enum values must be unquoted in inline queries
- `restaurant.name` is always null — use `restaurant.business.name`
- `deliveryTime: "ASAP"` is required for `createOrderFromCart` — empty string causes "scheduled delivery" error
- Cart IDs are unstable — create and use immediately

## Artifacts produced

| File | Contents |
|------|----------|
| `WORKLOG.md` | All 16 tested flows with working curl commands and notes |
| `HICCUPS.md` | 20 documented pitfalls with root causes and fixes |
| `CHEATSHEET.md` | Quick-reference index of all operations with WORKLOG section pointers |
| `REMAINING.md` | 5 actionable next steps + 8 open questions |
| `TASK_CHANGE_ADDRESS.md` | Detailed plan for the held "change delivery address" task |
