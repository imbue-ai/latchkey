approved

start with embedding a gitignored git repo here and use ghub to create the new public repo under imbue-ai. then start writing the docs into it.

-bowei

--

# Shipping Plan: DoorDash + Latchkey

## What We're Shipping

Documentation ("docs suitable for a human or agent to read") that lets someone go from zero to ordering food on DoorDash via CLI/agent. Two deliverables:

1. **Getting Started guide** — clone deps, build, auth, validate
2. **Cheatsheet** — common DoorDash GraphQL operations with copy-paste examples

## Where It Lives

New standalone repo: **`latchkey-doordash-agent-proto-skill`**

Clean, focused, single link to share. No latchkey internals or work session noise.

```
latchkey-doordash-agent-proto-skill/
├── README.md                  # Getting Started (steps 1-5)
├── CHEATSHEET.md              # All GraphQL operations + sharp edges
└── LICENSE                    # MIT
```

No scripts, no examples dir. Just docs. Human or agent reads them and follows along.

---

## Dependencies & Pinned Versions

| Dependency | Source | Pin |
|-----------|--------|-----|
| **latchkey** | `imbue-ai/latchkey` | Clone at hash `ad68247` (branch `bowei/doordash-clean`) |
| **curl_chrome136** | `lexiforest/curl-impersonate` releases | v1.5.6 — reader/agent figures out the right platform binary |
| **doordash-mcp** | `ashah360/doordash-mcp` | Clone at hash `405e748` — **reference material only** (GraphQL schema/queries), not intended for use |

### Why clone latchkey (not npm install)?

The DoorDash service lives on `bowei/doordash-clean`, not yet on npm. Cloning at a pinned hash ensures reproducibility.

### Why doordash-mcp?

Not for running. The repo contains comprehensive GraphQL query definitions across `src/api/*.ts` — serves as a reference for the full DoorDash GraphQL schema. Latchkey's auth story (browser login + cookie injection) is the actual interface.

---

## Getting Started Guide — Outline

### Prerequisites
- macOS or Linux
- Node.js 18+
- A DoorDash account with saved address + payment method

### Step 1: Clone Dependencies

```bash
# Clone latchkey at pinned hash
git clone https://github.com/imbue-ai/latchkey.git
cd latchkey
git checkout ad68247
npm install && npm run build

# Download curl_chrome136 from lexiforest/curl-impersonate v1.5.6
# (get the right binary for your platform from the GitHub releases page)

# Clone doordash-mcp at pinned hash (reference material only)
git clone https://github.com/ashah360/doordash-mcp.git
cd doordash-mcp
git checkout 405e748
```

### Step 2: Browser Auth into DoorDash

```bash
LATCHKEY_CURL=/path/to/curl_chrome136 npx latchkey auth browser doordash
```

- Opens browser window -> log into DoorDash
- Captures session cookies (ddweb_token, csrf_token, ddweb_session_id)
- Stored encrypted in `~/.latchkey`

### Step 3: Validate Auth + listCarts

```bash
LATCHKEY_CURL=/path/to/curl_chrome136 npx latchkey curl -s -X POST \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"query":"{ consumer { id email firstName } }"}' \
  'https://www.doordash.com/graphql/consumer'
```

Should return your name/email. If null fields -> re-auth.

Then test listCarts:

```bash
LATCHKEY_CURL=/path/to/curl_chrome136 npx latchkey curl -s -X POST \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"query":"{ listCarts(input: {cartContextFilter: {experienceCase: MULTI_CART_EXPERIENCE_CONTEXT, multiCartExperienceContext: {}}, cartFilter: {shouldIncludeSubmitted: true}}) { id subtotal restaurant { business { name } } orders { orderItems { quantity item { name } } } } }"}' \
  'https://www.doordash.com/graphql/listCarts?operation=listCarts'
```

### Step 4: Read the Cheatsheet

See CHEATSHEET.md for common operations and how to do whatever is asked.

---

## Cheatsheet — Outline

Based on ws-006 tested flows. Each entry: what it does, the curl command, gotchas.

### Operations to Document

| # | Operation | Endpoint | Notes |
|---|-----------|----------|-------|
| 1 | List carts | `listCarts` | `restaurant.name` is null, use `business.name` |
| 2 | Search restaurants | `autocompleteFacetFeed` | Store ID in click.data JSON |
| 3 | Get consumer info | `consumer` | Default address is here |
| 4 | View store menu | `storepageFeed` | Check `quickAddContext.isEligible` for required options |
| 5 | Get item details | `consumer?operation=itemPage` | `/graphql/itemPage` path is Cloudflare-blocked |
| 6 | Create cart (add first item) | `addCartItemV2` with `cartId: ""` | Empty cartId = new cart |
| 7 | Add item to existing cart | `addCartItemV2` with cartId | Must include `nestedOptions` even if `"[]"` |
| 8 | Add item with options | `addCartItemV2` | `nestedOptions` is complex JSON string |
| 9 | Preview checkout | `orderCart` | Cart must have items |
| 10 | Place order | `createOrderFromCart` | **Real money** — needs warning |
| 11 | Cancel order | `cancelOrder` | Need `orderUuid` (different from cartId) |
| 12 | Delete cart | `removeCart` | — |

### Sharp Edges Section

- Only inline queries work (no `operationName` + `variables`)
- Enum values unquoted (`Delivery` not `"Delivery"`)
- `nestedOptions` is a JSON string inside JSON
- `/graphql/itemPage` is blocked — route through `/graphql/consumer?operation=itemPage`
- `restaurant.name` always null — use `restaurant.business.name`
- Cart GC is aggressive — carts may disappear
- `orderUuid` != `cartId` for cancellation
- Partial refunds on cancellation

### Reference Material

For deeper GraphQL schema exploration, see the doordash-mcp clone at `src/api/*.ts` — contains query definitions for all 21 DoorDash operations (search, menu, cart, checkout, account, group orders).

---

## Privacy Checklist

Before publishing, verify:
- [ ] No real cookies, tokens, or session data in any committed file
- [ ] No email addresses in committed files
- [ ] No DoorDash user IDs or consumer IDs
- [ ] Example commands use placeholder values (`/path/to/curl_chrome136`, `CART-UUID`, etc.)
- [ ] DATA.md and ws-* dirs are NOT included

---

## Status of Dependencies

| Item | Status |
|------|--------|
| latchkey repo is public | Yes (`imbue-ai/latchkey`, confirmed) |
| DoorDash service on latchkey | On `bowei/doordash-clean` branch, hash `ad68247` (not merged to main yet) |
| doordash-mcp accessible | Yes (`ashah360/doordash-mcp`, hash `405e748`) |
| curl_chrome136 available | Yes (lexiforest/curl-impersonate v1.5.6 releases) |

---

## Next Steps

1. Review this plan
2. Write README.md (getting started guide)
3. Write CHEATSHEET.md (all 12 operations with full curl examples from ws-006)
4. Create the repo, push, share
