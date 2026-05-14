# Test Plan: Verifying the Docs Work

How do we know these docs actually help an agent accomplish things?

---

## Part 1: Installation (README)

### 1. Entry Point

An AI agent (e.g. Claude Code) is given a task like:
> "Set up DoorDash ordering capability by following the docs at https://github.com/imbue-ai/latchkey-doordash-agent-proto-skill"

The agent reads README.md and executes steps 1-3.

### 2. Desired Outcome

- latchkey cloned at correct hash, built successfully
- curl_chrome136 binary downloaded and executable
- doordash-mcp cloned at correct hash (reference)
- Browser auth completed — session cookies stored in `~/.latchkey`
- Validation query returns real consumer data (non-null id, email, firstName)
- listCarts query returns a valid response (even if empty array)

### 3. Transcript Signals (from JSONL)

| Signal | What to look for | Pass criteria |
|--------|-----------------|---------------|
| Clone latchkey | `git clone` + `git checkout ad68247` | Both commands exit 0 |
| Build latchkey | `npm install` + `npm run build` | Exit 0, no error output |
| Download curl_chrome136 | Fetches from lexiforest releases OR locates binary | Binary exists and is executable (`chmod +x` or already +x) |
| Clone doordash-mcp | `git clone` + `git checkout 405e748` | Both commands exit 0 |
| Browser auth | `latchkey auth browser doordash` invoked | Command completes (requires human in the loop — punting automation for now) |
| Validate consumer | curl to `/graphql/consumer` | Response JSON has non-null `consumer.id` and `consumer.email` |
| Validate listCarts | curl to `/graphql/listCarts` | Response JSON has `listCarts` key (array, possibly empty) |

### 4. System Ground Truth Signals

| Signal | How to check |
|--------|-------------|
| latchkey built | `ls latchkey/dist/` has files |
| curl_chrome136 works | `file curl_chrome136` shows executable binary |
| Credentials stored | `ls ~/.latchkey/` contains doordash credential files |
| Auth valid | Consumer query returns non-null fields |
| LATCHKEY_CURL set | Agent uses the env var in subsequent curl commands |

### 5. LLM-as-Judge Rubric

```
Grade the agent's installation attempt on these criteria (0-2 each):

CLONE_CORRECT (0-2):
  0 = Did not clone, or cloned wrong repos
  1 = Cloned repos but wrong hash / didn't checkout
  2 = Cloned all 3 repos at correct pinned hashes

BUILD_SUCCESS (0-2):
  0 = Build failed or not attempted
  1 = Partial build (npm install but no npm run build, or errors ignored)
  2 = Clean build with no errors

CURL_BINARY (0-2):
  0 = Did not obtain curl_chrome136
  1 = Downloaded but wrong platform or not made executable
  2 = Correct binary, executable, path known to agent

AUTH_FLOW (0-2):
  0 = Did not attempt browser auth
  1 = Attempted but did not complete or validate
  2 = Auth completed and validation query returned real user data

VALIDATION (0-2):
  0 = No validation attempted
  1 = Ran consumer query but didn't check listCarts (or vice versa)
  2 = Both consumer and listCarts queries returned valid responses

Total: /10
  8-10 = Full success
  5-7  = Partial (may work but gaps)
  0-4  = Failed setup
```

### 6. Installation Failure Modes & Recovery

| Failure | Likely cause | How agent should recover |
|---------|-------------|------------------------|
| `npm install` fails | Node version too old, network issue | Check `node --version` >= 18, retry with `--legacy-peer-deps` |
| `npm run build` TypeScript errors | Wrong hash checked out, partial clone | Verify `git log --oneline -1` matches `ad68247`, re-clone if needed |
| curl_chrome136 download 404 | Wrong platform string, release moved | Browse the releases page for correct asset name; try `curl_chrome142` as fallback |
| `chmod +x` permission denied | File on a noexec mount or wrong path | Move binary to home dir, retry chmod |
| `latchkey auth browser` hangs | No display (headless env), Playwright missing | Check `npx playwright install chromium`; can't run headless — needs a real browser |
| Consumer query returns all nulls | Session expired or auth didn't capture cookies | Re-run `latchkey auth browser doordash`, log in again |
| Consumer query returns 403 | LATCHKEY_CURL not set or pointing to wrong binary | Verify env var: `echo $LATCHKEY_CURL`, `file $LATCHKEY_CURL` |
| listCarts returns error | Auth valid but cookies partially captured | Re-auth; if persists, check `~/.latchkey` has 3 cookies (ddweb_token, csrf_token, ddweb_session_id) |

---

## Part 2: Actions (CHEATSHEET)

### 1. Entry Point

Agent has completed installation (Part 1 passed). Given a specific task. Agent reads CHEATSHEET.md and chains operations together.

### 2. Handling Mutable DoorDash State

DoorDash state changes under you. Tests must account for this:

- **Cart GC**: Carts disappear if idle too long. Agent should re-list carts before acting on stale cart UUIDs. If a cart UUID returns CART_NOT_FOUND, create a new one.
- **Store hours**: Stores close. McDonald's is 24h in most metros — use McDonald's as the stable test store. If closed, agent should try a different store rather than fail.
- **Menu changes**: Items get removed or prices change. Agent should not hardcode item IDs — always search + browse menu to get current IDs.
- **Price drift**: `unitPrice` in addCartItem should match current menu price. If mismatch, re-fetch from storepageFeed.

### 3. Test Scenarios

Three scenarios covering read-only, cart write, and full order flow. Each has a task-specific rubric.

---

#### Scenario A: "What's on the Sweetgreen menu near me, and what options does the Harvest Bowl have?"

**Type**: Read-only, no cost, no side effects

**Expected operation sequence**:
1. `autocompleteFacetFeed` — search "Sweetgreen", extract storeId
2. `storepageFeed` — get menu categories and items
3. `itemPage` (via `/graphql/consumer?operation=itemPage`) — get Harvest Bowl options

**Recovery situations**:
- Sweetgreen not found in search → try alternate spelling, or report "not available"
- Harvest Bowl not on menu → report what IS on menu
- 403 on itemPage → agent should know to route through `/graphql/consumer`

**Rubric**:
```
SEARCH_CORRECT (0-2):
  0 = Didn't search or used wrong endpoint
  1 = Searched but couldn't extract storeId from results
  2 = Found Sweetgreen and extracted storeId

MENU_RETRIEVED (0-2):
  0 = Didn't fetch menu or got error
  1 = Got menu but missed categories or items
  2 = Full menu with item names, prices, categories

ITEM_DETAILS (0-2):
  0 = Didn't fetch Harvest Bowl options
  1 = Fetched but used wrong endpoint (/graphql/itemPage) or wrong item
  2 = Correct item details with option groups via consumer?operation=itemPage

ANSWER_QUALITY (0-2):
  0 = No useful answer to user
  1 = Partial answer (menu OR options, not both)
  2 = Complete answer covering menu overview + Harvest Bowl options

SHARP_EDGES (0-2):
  0 = Hit 2+ sharp edges (403, null restaurant.name, quoted enums)
  1 = Hit 1 but recovered
  2 = Clean — no sharp edges hit

Total: /10
```

---

#### Scenario B: "Add a water and an apple juice from McDonald's to a new cart, then tell me the total"

**Type**: Cart write, no cost, reversible (cart can be deleted)

**Expected operation sequence**:
1. `autocompleteFacetFeed` — search "McDonald's", extract storeId
2. `storepageFeed` — find quickAdd-eligible water and apple juice items, get menuBookId
3. `addCartItemV2` with `cartId: ""` — create cart with first item (water)
4. `addCartItemV2` with `cartId: "NEW_CART_UUID"` — add second item (apple juice)
5. `orderCart` — preview checkout to get total

**Recovery situations**:
- Water/juice not on menu → find closest match or report unavailable
- addCartItem returns error → check nestedOptions is `"[]"`, enums unquoted, unitPrice matches menu
- Cart UUID from step 3 not working in step 4 → cart may have been GC'd; re-create
- Accidentally used wrong cartId → listCarts to find actual cart, or start over
- orderCart returns CART_NOT_FOUND → cart was GC'd between add and preview; re-create

**Rubric**:
```
SEARCH_AND_MENU (0-2):
  0 = Couldn't find McDonald's or menu
  1 = Found store but picked wrong items (non-quickAdd, wrong IDs)
  2 = Found store, identified quickAdd-eligible water + juice with correct IDs

CART_CREATION (0-2):
  0 = Failed to create cart or wrong mutation format
  1 = Created cart with one item but couldn't add second
  2 = Both items added to same cart, cart UUID tracked correctly

QUERY_FORMAT (0-2):
  0 = Multiple malformed queries (wrong enums, bad nestedOptions, missing headers)
  1 = One format error but self-corrected
  2 = All queries correctly formatted on first attempt

TOTAL_RETRIEVED (0-2):
  0 = Didn't get checkout preview
  1 = Got subtotal from listCarts (not the real total with fees)
  2 = Used orderCart to get total including fees/tax

RECOVERY (0-2):
  0 = Got stuck on error with no recovery attempt
  1 = Recovered from error but messily (extra carts left behind, multiple retries)
  2 = Clean recovery or no errors to recover from

Total: /10
```

---

#### Scenario C: "Order me the cheapest item from McDonald's, then immediately cancel it"

**HEADS UP: This costs real money. Cancellation refund is partial — expect to lose ~$5 in fees. Only run this test when intentionally validating the full order flow.**

**Type**: Full order + cancel, real charges, partial refund

**Expected operation sequence**:
1. `autocompleteFacetFeed` — search "McDonald's"
2. `storepageFeed` — find cheapest quickAdd item (likely a condiment or water)
3. `addCartItemV2` with `cartId: ""` — create cart
4. `orderCart` — preview total, confirm with user before proceeding
5. `createOrderFromCart` — place order (returns `orderUuid`)
6. `previewOrderCancellation` — check refund amount
7. `orderCancellation` — cancel using `orderUuid` (NOT cartId)

**Recovery situations**:
- `createOrderFromCart` fails with total mismatch → re-fetch orderCart, use updated total
- Agent uses `deliveryTime: ""` instead of `"ASAP"` → scheduled delivery error; fix and retry
- Agent tries to cancel with cartId instead of orderUuid → statusCode 0 (no-op); must use orderUuid from step 5
- Order already picked up by dasher → cancellation may fail or give $0 refund; report to user
- Agent doesn't confirm with user before placing order → rubric penalizes this

**Rubric**:
```
ORDER_FLOW (0-2):
  0 = Failed to place order
  1 = Placed order but with errors along the way (wrong total, retries)
  2 = Clean order placement: search -> menu -> cart -> preview -> confirm -> order

USER_CONFIRMATION (0-2):
  0 = Placed order without telling user the total or asking to proceed
  1 = Showed total but didn't wait for confirmation
  2 = Showed total and confirmed before placing order

CANCEL_FLOW (0-2):
  0 = Failed to cancel or used wrong UUID
  1 = Cancelled but used cartId first (wasted call), then found orderUuid
  2 = Used orderUuid correctly on first attempt, verified statusCode: 1

UUID_TRACKING (0-2):
  0 = Confused cartId and orderUuid throughout
  1 = Mixed up once but corrected
  2 = Correctly distinguished cartId vs orderUuid at every step

DELIVERY_TIME (0-2):
  0 = Used empty string or omitted deliveryTime (caused error)
  1 = Got error, then fixed to "ASAP"
  2 = Used "ASAP" correctly on first attempt

Total: /10
```

---

## Summary

| Scenario | Type | Cost | Key thing it tests |
|----------|------|------|--------------------|
| A | Read-only | Free | Search + menu + itemPage routing (sharp edge: 403) |
| B | Cart writes | Free | Multi-item cart building + checkout preview + cart state tracking |
| C | Full order | ~$5-15 | Order placement + cancellation + UUID tracking + user confirmation |

Run A and B freely for iteration. Run C sparingly and only with explicit intent.
