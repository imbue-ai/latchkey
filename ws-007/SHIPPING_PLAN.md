# Shipping Plan: DoorDash + Latchkey

## What We're Shipping

Documentation ("docs suitable for a human or agent to read") that lets someone go from zero to ordering food on DoorDash via CLI/agent. Two deliverables:

1. **Getting Started guide** — clone, build, auth, validate
2. **Cheatsheet** — common DoorDash GraphQL operations with copy-paste examples

## Key Decision: Where Does This Live?

Options:

### A. New standalone repo (e.g. `imbue-ai/doordash-agent-guide`)
- Clean, focused, easy to share a single link
- Can include the cheatsheet + getting started as README or separate docs
- No noise from latchkey internals or work session logs
- Easy to pin dependency versions

### B. Subfolder in latchkey repo (e.g. `docs/guides/doordash/`)
- Stays close to source code
- But latchkey is a general tool — doordash-specific guide feels out of place
- Work session dirs (ws-001 through ws-008) would be visible

### C. Part of doordash-mcp repo
- Already has DoorDash context
- But that repo uses CycleTLS, not latchkey+curl_chrome136
- Mixing two approaches would confuse readers

**Recommendation: Option A** — new standalone repo. Clean, shareable, single-purpose.

---

## Dependencies & Pinned Versions

Three repos users need:

| Dependency | Source | Pin Strategy |
|-----------|--------|-------------|
| **latchkey** | `imbue-ai/latchkey` (npm: `latchkey`) | Pin npm version (e.g. `latchkey@2.11.0`) or git hash |
| **curl_chrome136** | `lexiforest/curl-impersonate` releases | Pin release tag (v1.5.6) + provide direct download URLs per platform |
| **doordash-mcp** | `ashah360/doordash-mcp` | Pin git hash — this repo may evolve independently |

### curl_chrome136 Distribution Question

The binary is ~5MB. Options:
- **A. Direct users to lexiforest/curl-impersonate releases** — cleanest, no hosting burden
- **B. Include in guide repo as a release asset** — more control, but maintenance burden
- **C. Script that downloads it** — best UX, but URL may break

**Recommendation: A + C** — provide download URLs to lexiforest releases + a setup script that fetches the right binary for the platform.

---

## Getting Started Guide — Outline

### Prerequisites
- macOS (arm64 or x64) or Linux
- Node.js 18+
- A DoorDash account with saved address + payment method

### Step 1: Install latchkey + curl_chrome136

```bash
# Install latchkey
npm install -g latchkey@2.11.0

# Download curl_chrome136 for your platform
# macOS arm64:
curl -L -o curl_chrome136 "https://github.com/lexiforest/curl-impersonate/releases/download/v1.5.6/curl_chrome136-macos-arm64"
chmod +x curl_chrome136
```

### Step 2: Browser Auth into DoorDash

```bash
LATCHKEY_CURL=$(pwd)/curl_chrome136 npx latchkey auth browser doordash
```

- Opens browser window → log into DoorDash
- Captures session cookies (ddweb_token, csrf_token, ddweb_session_id)
- Stored encrypted in `~/.latchkey`

### Step 3: Validate Auth

```bash
LATCHKEY_CURL=$(pwd)/curl_chrome136 npx latchkey curl -s -X POST \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"query":"{ consumer { id email firstName } }"}' \
  'https://www.doordash.com/graphql/consumer'
```

Should return your name/email. If null fields → re-auth.

### Step 4: Test listCarts

```bash
LATCHKEY_CURL=$(pwd)/curl_chrome136 npx latchkey curl -s -X POST \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"query":"{ listCarts(input: {cartContextFilter: {experienceCase: MULTI_CART_EXPERIENCE_CONTEXT, multiCartExperienceContext: {}}, cartFilter: {shouldIncludeSubmitted: true}}) { id subtotal restaurant { business { name } } orders { orderItems { quantity item { name } } } } }"}' \
  'https://www.doordash.com/graphql/listCarts?operation=listCarts'
```

### Step 5: Read the Cheatsheet

Link to cheatsheet doc for all common operations.

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

---

## Optional: doordash-mcp Integration

For agent use via MCP (Claude Desktop / Cursor), also document:

```bash
git clone https://github.com/ashah360/doordash-mcp.git
cd doordash-mcp && npm install && npm run build
```

Add to MCP config with email/password env vars. Note: uses CycleTLS (no curl_chrome136 needed), automated login (no browser).

**Question**: Do we want to ship both approaches (latchkey+curl vs doordash-mcp) or just one?

---

## Repo Structure (if Option A)

```
doordash-agent-guide/          (or whatever name)
├── README.md                  # Getting Started (steps 1-5)
├── CHEATSHEET.md              # All GraphQL operations
├── setup.sh                   # Downloads curl_chrome136 + installs latchkey
├── examples/
│   ├── search-and-order.sh    # End-to-end scripted example
│   └── browse-menu.sh         # Browse a store's menu
└── TROUBLESHOOTING.md         # Common issues (403s, null fields, expired sessions)
```

---

## Open Questions

1. **Repo name?** `doordash-agent-guide`, `doordash-cli`, `doordash-agent-toolkit`?
2. **Ship both latchkey+curl AND doordash-mcp?** Or just one path?
3. **License?** MIT? Apache 2.0? Match latchkey's license?
4. **Audience?** Developers? Agent builders? Both?
5. **curl_chrome136 platforms** — currently only tested on macOS arm64. Do we support Linux? x64 mac?
6. **Session expiry** — how long do DoorDash sessions last? Should docs cover re-auth?
7. **doordash-mcp pin hash** — which commit? Is `ashah360/doordash-mcp` stable?
8. **latchkey branch** — ship from `main` or does the doordash service need to be merged first?
9. **Privacy** — DATA.md has real cookies/tokens/emails. Ensure nothing leaks into public repo.
10. **Is `imbue-ai/latchkey` already public?** If not, that's a blocker.
