bowei:

instal/readme plans make sense, there's only 1 logical entry point.
maybe we should think about ways the install could fail and how to recover.

cheathset plans - it makes more sense to tailor the rubric based on the specific task.

we haven't decided on how exactly to implement the tests yet - we'll do that thinking separately. 

- **Browser auth is human-in-the-loop** — how do we handle this in automated test runs? Pre-auth and snapshot `~/.latchkey`?
you're right, see above, let's punt this for now
- **DoorDash state is mutable** — carts get GC'd, menus change, stores close. Tests need to be time-aware or use stable stores.
yes solve it
- **Cost of Tier 3 tests** — real charges. Run sparingly. Cancellation refunds are partial.
yes acknowledged, let's put a heads up in the test
- **Transcript format** — what JSONL schema are we capturing? Tool calls + results? Full conversation?
see above, impl dependent


--

# Test Plan: Verifying the Docs Work

How do we know these docs actually help an agent accomplish things?

---

## Part 1: Installation (README)

### 1. Entry Point

An AI agent (e.g. Claude Code) is given a task like:
> "Set up DoorDash ordering capability by following the docs at latchkey-doordash-agent-proto-skill"

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
| Browser auth | `latchkey auth browser doordash` invoked | Command completes (requires human in the loop for actual login) |
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

---

## Part 2: Actions (CHEATSHEET)

### 1. Entry Point

Agent has completed installation (Part 1 passed). Given a task like:
> "Order me a water from the nearest McDonald's"

Agent reads CHEATSHEET.md and chains together the right operations.

### 2. Desired Outcome

Depends on the task. Example workflows:

**Browse workflow**: Search -> menu -> item details -> report back
- Agent finds the store, gets menu, answers the user's question

**Order workflow**: Search -> menu -> create cart -> (add items) -> preview checkout -> place order
- Agent creates a cart, adds items, confirms total, places order

**Cancel workflow**: Place order -> cancel order
- Agent uses orderUuid (not cartId) to cancel

### 3. Transcript Signals (from JSONL)

| Signal | What to look for | Pass criteria |
|--------|-----------------|---------------|
| Correct endpoint used | URL matches operation (e.g. `storepageFeed` for menu) | Agent doesn't use wrong endpoints |
| Inline query format | No `operationName` or `variables` keys in payload | All queries are inline |
| Enums unquoted | `Delivery` not `"Delivery"`, `contact` not `"contact"` | No quoted enums |
| itemPage routed correctly | Uses `/graphql/consumer?operation=itemPage` | Does NOT use `/graphql/itemPage` |
| business.name not restaurant.name | Reads store name from `business.name` | Never relies on null `restaurant.name` |
| Cart creation | `cartId: ""` for new cart | Agent knows empty string = new cart |
| nestedOptions format | Correct triple-escaped JSON string structure | Not malformed JSON |
| orderUuid vs cartId | Uses `orderUuid` from createOrderFromCart for cancellation | Never passes cartId to cancel/preview |
| LATCHKEY_CURL prefix | Every curl command uses the env var | No bare curl to doordash.com |
| Headers present | `Content-Type` and `Accept` headers on every request | Never missing |

### 4. System / DoorDash Ground Truth Signals

| Signal | How to check |
|--------|-------------|
| Search worked | Response has `autocompleteFacetFeed.body` with results |
| Menu loaded | Response has `storepageFeed.storeHeader.name` and `itemLists` |
| Cart created | Response has `addCartItemV2` with new cart `id` |
| Cart has items | `listCarts` shows items in cart |
| Checkout preview valid | `orderCart` returns `total` > 0 |
| Order placed | `createOrderFromCart` returns `orderUuid` |
| Order cancelled | `orderCancellation` returns `statusCode: 1` |
| DoorDash confirms | Order appears in DoorDash order history (external check) |

### 5. LLM-as-Judge Rubric

```
Grade the agent's task execution on these criteria (0-2 each):

OPERATION_SELECTION (0-2):
  0 = Used wrong operations or random guessing
  1 = Mostly right sequence but missed a step or did unnecessary steps
  2 = Correct minimal sequence of operations for the task

SHARP_EDGES_AVOIDED (0-2):
  0 = Hit 2+ known sharp edges (403, null name, wrong UUID, quoted enums)
  1 = Hit 1 sharp edge but recovered
  2 = Avoided all sharp edges on first attempt

QUERY_CORRECTNESS (0-2):
  0 = Queries malformed or returned errors
  1 = Some queries worked, some needed retry/fix
  2 = All queries well-formed and returned valid data

TASK_COMPLETED (0-2):
  0 = Task goal not achieved
  1 = Partially achieved (e.g. found restaurant but couldn't order)
  2 = Fully achieved (e.g. order placed, or info reported back correctly)

EFFICIENCY (0-2):
  0 = Excessive retries, dead ends, or unnecessary operations
  1 = Some wasted calls but got there
  2 = Clean execution with minimal unnecessary calls

Total: /10
  8-10 = Docs are working well
  5-7  = Docs are usable but have gaps
  0-4  = Docs need significant revision
```

---

## Test Scenarios

Concrete tasks to run, ordered by complexity:

### Tier 1: Read-only (safe, no cost)
1. **"What's on the Sweetgreen menu near me?"** — search + storepageFeed
2. **"What customization options does the Harvest Bowl have?"** — search + storepageFeed + itemPage
3. **"Do I have any active carts?"** — listCarts
4. **"What's my delivery address?"** — consumer query

### Tier 2: Cart manipulation (safe, no cost)
5. **"Add a water from McDonald's to a new cart"** — search + storepageFeed + addCartItemV2 (cartId="")
6. **"Add a Harvest Bowl with corn salsa to my cart"** — search + storepageFeed + itemPage + addCartItemV2 with nestedOptions
7. **"How much would it cost to order what's in my cart?"** — listCarts + orderCart preview
8. **"Remove the last item from my cart"** — listCarts + removeCartItemV2
9. **"Delete my cart"** — listCarts + deleteCart

### Tier 3: Real orders (costs money)
10. **"Order me a water from McDonald's"** — full flow through createOrderFromCart
11. **"Order me a water from McDonald's, then cancel it"** — full flow + orderCancellation

---

## Open Questions

- **Browser auth is human-in-the-loop** — how do we handle this in automated test runs? Pre-auth and snapshot `~/.latchkey`?
- **DoorDash state is mutable** — carts get GC'd, menus change, stores close. Tests need to be time-aware or use stable stores.
- **Cost of Tier 3 tests** — real charges. Run sparingly. Cancellation refunds are partial.
- **Transcript format** — what JSONL schema are we capturing? Tool calls + results? Full conversation?
