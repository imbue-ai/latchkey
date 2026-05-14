# DoorDash Latchkey Curl API — Worklog

## Setup

- **curl binary**: `LATCHKEY_CURL=/Users/bowei/code/latchkey/ws-002/tools/curl_chrome136`
- **Auth status**: valid (consumer ID `895291629`, email `ops@imbue.com`)
- **Endpoint pattern**: `POST https://www.doordash.com/graphql/{operation}?operation={operation}`

## Critical Finding: Inline Queries Only

**operationName + variables format = 400 Bad Request every time.**

DoorDash rejects the standard GraphQL format:
```json
{"operationName":"listCarts","variables":{...},"query":"query listCarts($input: ...) { ... }"}
```

Must use fully inline queries (no variables, no operationName):
```json
{"query":"{ listCarts(input: {cartContextFilter: ...}) { id ... } }"}
```

This applies to ALL endpoints tested so far. The doordash-mcp CycleTLS code uses operationName+variables and it works there — so this may be a curl_chrome136 vs CycleTLS difference, or a header difference.

Tried adding `apollographql-client-name` and `apollographql-client-version` headers — still 400 with variables format.

## Tested Flows

### 1. Fetch All Carts — WORKS
```bash
LATCHKEY_CURL=.../curl_chrome136 npx latchkey curl -s -X POST \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"query":"{ listCarts(input: {cartContextFilter: {experienceCase: MULTI_CART_EXPERIENCE_CONTEXT, multiCartExperienceContext: {}}, cartFilter: {shouldIncludeSubmitted: true}}) { id subtotal restaurant { id name business { name } } orders { orderItems { id quantity item { id name } } } } }"}' \
  'https://www.doordash.com/graphql/listCarts?operation=listCarts'
```
- `restaurant.name` is always null — use `restaurant.business.name` instead
- Returns all active carts with items

### 2. Search Restaurants — WORKS
```bash
LATCHKEY_CURL=.../curl_chrome136 npx latchkey curl -s -X POST \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"query":"{ autocompleteFacetFeed(query: \"Sweetgreen\") { body { id body { id text { title subtitle } events { click { data } } } } } }"}' \
  'https://www.doordash.com/graphql/autocompleteFacetFeed?operation=autocompleteFacetFeed'
```
- Store ID in click.data JSON: `{"uri":"store/65695/?pickup=false"}` -> storeId=65695
- First result is best match, rest are suggested queries

### 3. Consumer Identity + Default Address — WORKS
```bash
LATCHKEY_CURL=.../curl_chrome136 npx latchkey curl -s -X POST \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"query":"{ consumer { id email defaultAddress { id street city state zipCode } } }"}' \
  'https://www.doordash.com/graphql/consumer'
```
- `defaultAddress` = where all carts will deliver to (account-level, not per-cart)

### 3b. Checkout / Order Preview (orderCart) — WORKS
```bash
LATCHKEY_CURL=.../curl_chrome136 npx latchkey curl -s -X POST \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"query":"{ orderCart(id: \"CART-UUID\", isCardPayment: true) { id subtotal total fulfillmentType asapMinutesRange isOutsideDeliveryRegion restaurant { name address { printableAddress street city state } business { name } } creator { id firstName lastName } } }"}' \
  'https://www.doordash.com/graphql/consumer?operation=orderCart'
```
- Shows total (with fees/tax), delivery ETA, store address, fulfillment type
- `deliveryFee`, `deliveryFeeDetails`, `deliveries`, `selectedDeliveryOption` all return null — not populated until deeper in checkout flow
- **Cart must have items** — empty carts return CART_NOT_FOUND
- Delivery address is NOT on the cart — it's on `consumer.defaultAddress`

### 4. Store Menu (storepageFeed) — WORKS
```bash
LATCHKEY_CURL=.../curl_chrome136 npx latchkey curl -s -X POST \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"query":"{ storepageFeed(storeId: \"65695\", isMerchantPreview: false) { storeHeader { id name description priceRangeDisplayString asapMinutes ratings { averageRating numRatingsDisplayString } address { street city } } menuBook { id } itemLists { id name items { id name description displayPrice quickAddContext { isEligible price { unitAmount } nestedOptions } } } } }"}' \
  'https://www.doordash.com/graphql/storepageFeed?operation=storepageFeed'
```
- Returns store header (name, rating, address) + menu categories + items
- `quickAddContext.isEligible` — if false, item has required options (e.g. size)
- Sweetgreen: ALL items have quickAddContext.isEligible=false (all need size choice)
- `menuBook.id` needed later for addCartItem

### 5. Item Details (itemPage) — WORKS (with workaround)
```bash
LATCHKEY_CURL=.../curl_chrome136 npx latchkey curl -s -X POST \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"query":"{ itemPage(storeId: \"65695\", itemId: \"12818405200\", isMerchantPreview: false, fulfillmentType: Delivery) { itemHeader { name description unitAmount caloricInfoDisplayString quantityLimit } optionLists { name isOptional minNumOptions maxNumOptions options { id name unitAmount displayString } } } }"}' \
  'https://www.doordash.com/graphql/consumer?operation=itemPage'
```
- **CRITICAL**: `/graphql/itemPage` returns 403 (Cloudflare blocks this specific path)
- **Workaround**: Route through `/graphql/consumer?operation=itemPage` — works perfectly
- GraphQL routing doesn't depend on URL path, only Cloudflare filtering does
- Shows option groups (size, toppings, etc.) with min/max selections
- `fulfillmentType: Delivery` must use capital D (enum, not string)

### 6. Create New Cart — WORKS
```bash
# Creates a new cart by adding an item with cartId=""
LATCHKEY_CURL=.../curl_chrome136 npx latchkey curl -s -X POST \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"query":"mutation { addCartItemV2(addCartItemInput: {storeId: \"653630\", menuId: \"90095146\", itemId: \"38059043990\", itemName: \"DASANI Bottled Water\", itemDescription: \"\", currency: \"USD\", quantity: 1, nestedOptions: \"[]\", specialInstructions: \"\", substitutionPreference: contact, unitPrice: 369, cartId: \"\", isBundle: false, bundleType: null}, fulfillmentContext: {shouldUpdateFulfillment: false, fulfillmentType: Delivery}, monitoringContext: {isGroup: false}, cartContext: {isBundle: false}, returnCartFromOrderService: false, shouldKeepOnlyOneActiveCart: false, lowPriorityBatchAddCartItemInput: []) { id subtotal orders { orderItems { id quantity item { id name } } } } }"}' \
  'https://www.doordash.com/graphql/addCartItem?operation=addCartItem'
```
- `cartId: ""` = create new cart
- Use `quickAddContext.isEligible` items for simple adds (no required options)
- McDonald's DASANI Water (id=38059043990) and condiments are quickAdd eligible
- `substitutionPreference: contact` and `fulfillmentType: Delivery` are ENUMS — must be unquoted!
- Returns new cartId in response

### 7. Add Item to Cart (preserving contents) — WORKS
```bash
# Pass existing cartId to add to same cart
LATCHKEY_CURL=.../curl_chrome136 npx latchkey curl -s -X POST \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"query":"mutation { addCartItemV2(addCartItemInput: {storeId: \"653630\", menuId: \"90095146\", itemId: \"38059043993\", itemName: \"Honest Kids Apple Juice\", itemDescription: \"\", currency: \"USD\", quantity: 1, nestedOptions: \"[]\", specialInstructions: \"\", substitutionPreference: contact, unitPrice: 269, cartId: \"EXISTING-CART-UUID\", isBundle: false, bundleType: null}, fulfillmentContext: {shouldUpdateFulfillment: false, fulfillmentType: Delivery}, monitoringContext: {isGroup: false}, cartContext: {isBundle: false}, returnCartFromOrderService: false, shouldKeepOnlyOneActiveCart: false, lowPriorityBatchAddCartItemInput: []) { id subtotal orders { orderItems { id quantity item { id name } } } } }"}' \
  'https://www.doordash.com/graphql/addCartItem?operation=addCartItem'
```
- Key: pass `cartId: "existing-uuid"` — existing items preserved, new item appended
- Response includes ALL items in cart (both old and new)
- Must add items from same store as existing cart

### 8. Add Item with Configured Options — WORKS
```bash
# Harvest Bowl with Add Corn Salsa option
LATCHKEY_CURL=.../curl_chrome136 npx latchkey curl -s -X POST \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"query":"mutation { addCartItemV2(addCartItemInput: {storeId: \"65695\", menuId: \"34497946\", itemId: \"12818405200\", itemName: \"Harvest Bowl\", itemDescription: \"\", currency: \"USD\", quantity: 1, nestedOptions: \"[{\\\"itemExtraOption\\\":{\\\"id\\\":\\\"51342150685\\\",\\\"name\\\":\\\"Add Corn Salsa\\\",\\\"price\\\":75},\\\"id\\\":\\\"51342150685\\\",\\\"quantity\\\":1,\\\"options\\\":[]}]\", specialInstructions: \"\", substitutionPreference: contact, unitPrice: 1950, cartId: \"\", isBundle: false, bundleType: null}, fulfillmentContext: {shouldUpdateFulfillment: false, fulfillmentType: Delivery}, monitoringContext: {isGroup: false}, cartContext: {isBundle: false}, returnCartFromOrderService: false, shouldKeepOnlyOneActiveCart: false, lowPriorityBatchAddCartItemInput: []) { id subtotal orders { orderItems { id quantity nestedOptions item { id name } } } } }"}' \
  'https://www.doordash.com/graphql/addCartItem?operation=addCartItem'
```

#### nestedOptions format
The `nestedOptions` field is a **JSON string** (escaped inside the query). Each option is:
```json
[{
  "itemExtraOption": {
    "id": "OPTION_ID",
    "name": "Option Name",
    "price": 75
  },
  "id": "OPTION_ID",
  "quantity": 1,
  "options": []
}]
```
- Minimal fields (`id`, `name`, `price`) work — don't need `itemExtraId`, `merchantSuppliedItemId`, etc.
- Get option IDs from `itemPage` query's `optionLists[].options[].id`
- For items with REQUIRED options (isOptional=false), must include selections for ALL required groups
- Starbucks drinks have 4+ required option groups (Size, Espresso Shots, Espresso Roast, Milk Temp, Milk Options) — very complex
- Sweetgreen items with all-optional options can be added with `nestedOptions: "[]"` (no options required)

### 9. Delete Cart — WORKS
```bash
LATCHKEY_CURL=.../curl_chrome136 npx latchkey curl -s -X POST \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"query":"mutation { deleteCart(cartId: \"CART-UUID\") }"}' \
  'https://www.doordash.com/graphql/deleteCart?operation=deleteCart'
```
- Returns `{"data":{"deleteCart":true}}`

### 10. Place Order (createOrderFromCart) — WORKS, TESTED LIVE
```bash
LATCHKEY_CURL=.../curl_chrome136 npx latchkey curl -s -X POST \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"query":"mutation { createOrderFromCart(cartId: \"CART-UUID\", total: 1074, sosDeliveryFee: 0, isPickupOrder: false, verifiedAgeRequirement: false, deliveryTime: \"ASAP\", isCardPayment: true) { orderUuid } }"}' \
  'https://www.doordash.com/graphql/consumer?operation=createOrderFromCart'
```
- `total` = total in cents from `orderCart` response (includes fees/tax)
- `deliveryTime: "ASAP"` — **must be "ASAP"**, empty string `""` causes "Scheduled delivery must set scheduled delivery time" error
- Returns `orderUuid` — this is NOT the cart UUID, needed for cancellation
- **Tested live**: Starbucks Iced Lemon Loaf ($5.25 item, $10.74 total) → orderUuid `820244b8-4eb1-485a-be13-806ca10392d7`
- Cart gets consumed after order — cannot reuse same cartId

### 11. Order Cancellation — TESTED LIVE

**Preview** (read-only, shows refund amount):
```bash
LATCHKEY_CURL=.../curl_chrome136 npx latchkey curl -s -X POST \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"query":"{ previewOrderCancellation(orderUuid: \"ORDER-UUID\") { statusCode refund { currency displayString unitAmount } } }"}' \
  'https://www.doordash.com/graphql/consumer?operation=previewOrderCancellation'
```

**Execute cancellation**:
```bash
LATCHKEY_CURL=.../curl_chrome136 npx latchkey curl -s -X POST \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"query":"mutation { orderCancellation(orderUuid: \"ORDER-UUID\") { statusCode refund { currency displayString unitAmount } } }"}' \
  'https://www.doordash.com/graphql/consumer?operation=orderCancellation'
```
- Takes `orderUuid` (from `createOrderFromCart` response, NOT the cart UUID)
- **statusCode meanings**: `0` = no-op (invalid/nonexistent UUID), `1` = real cancellation executed
- **Tested live**: cancelled order `820244b8-...` → `statusCode: 1`, refund `unitAmount: -549` ($5.49 USD)
- Refund was $5.49 on $10.74 total — partial refund (likely delivery fee + service fee not refunded)
- `previewOrderCancellation` returns same result as `orderCancellation` — use preview to check before executing
- Calling cancellation again on same UUID still returns `statusCode: 1` (idempotent)

### 12. Remove Single Item from Cart (removeCartItemV2) — WORKS
```bash
LATCHKEY_CURL=.../curl_chrome136 npx latchkey curl -s -X POST \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"query":"mutation { removeCartItemV2(cartId: \"CART-UUID\", itemId: \"ORDER-ITEM-UUID\") { id subtotal orders { orderItems { id quantity item { id name } } } } }"}' \
  'https://www.doordash.com/graphql/consumer?operation=removeCartItemV2'
```
- `cartId` = cart UUID from `listCarts`
- `itemId` = the **orderItem UUID** (e.g. `8c733f80-...`), NOT the catalog item ID (e.g. `27405467235`)
- Returns `OrderCart` type — can request same fields as `orderCart` query
- **Tested live**: removed GREEN JUICE from Rad Radish cart. Subtotal dropped $51.00 → $42.00, item count 4 → 3.

## Endpoint Cloudflare Status

Tested all with dummy `{"query":"{ consumer { id } }"}` payload:
| Endpoint path | Status |
|---|---|
| `/graphql/consumer` | 200 |
| `/graphql/listCarts` | 200 |
| `/graphql/autocompleteFacetFeed` | 200 |
| `/graphql/storepageFeed` | 200 |
| `/graphql/addCartItem` | 200 |
| `/graphql/deleteCart` | 200 |
| `/graphql/getConsumerOrdersWithDetails` | 200 |
| `/graphql/getAvailableAddresses` | 200 |
| `/graphql/itemPage` | **403** |

All curl_chrome versions (136, 142, 146) get 403 on itemPage. Workaround: route any query through an unblocked path like `/graphql/consumer`.

## Sharp Edges / Don't Do Again

1. **Never use `operationName` + `variables` in curl** — always inline. 400 every time.
2. **Never use `restaurant.name`** — always null, use `restaurant.business.name`
3. **Don't pass service name as positional arg** — latchkey curl syntax is `npx latchkey curl [flags] URL` (URL-based service matching)
4. **Latchkey auto-injects**: Cookie, x-csrftoken, x-channel-id, x-experience-id, Origin, Referer — don't need to add those manually
5. **Always add**: `-H 'Content-Type: application/json' -H 'Accept: application/json'` — curl_chrome136 default Accept is HTML
6. **`/graphql/itemPage` is 403** — route through `/graphql/consumer` instead
7. **GraphQL path segment is cosmetic** — DoorDash routes all queries through any `/graphql/*` path; only Cloudflare cares about the path
8. **Enum values must be UNQUOTED** in inline queries — `substitutionPreference: contact` not `"contact"`, `fulfillmentType: Delivery` not `"Delivery"`. Quoted enums give validation error.
9. **`nestedOptions` format is complex** — needs `itemExtraOption` wrapper with `id`, `name`, `price` fields. Simple `{"id":"..","quantity":1}` causes internal-server-error.
10. **Items with required options need ALL required groups** — partial selections fail silently or with internal-server-error. Check `isOptional` on each optionList.
11. **`quickAddContext.isEligible`** — only these items can be added with `nestedOptions: "[]"`. Non-eligible items may need size/flavor selections.
12. **`menuBook.id` from storepageFeed** — pass as `menuId` in addCartItem. Can also pass `""` but best to include it.
13. **`deliveryTime` must be `"ASAP"`** — empty string `""` causes "Scheduled delivery must set scheduled delivery time" error. Don't omit it either.
14. **Cart GC is aggressive** — DoorDash garbage-collects idle/empty carts quickly. Create cart and use immediately. UUIDs can change between calls.
15. **`orderUuid` ≠ cart UUID** — `createOrderFromCart` returns an `orderUuid` which is different from the `cartId`. Use `orderUuid` for cancellation.
16. **Cancellation refund may be partial** — $5.49 refund on $10.74 order. Fees likely not refunded.

## Test Reference Data

| Restaurant | storeId | menuBookId |
|---|---|---|
| Sweetgreen (171 2nd St, SF) | 65695 | 34497946 |
| McDonald's (SF) | 653630 | 90095146 |
| Starbucks (SF) | 36737969 | 82815346 |

quickAdd-eligible items at McDonald's: DASANI Water (38059043990, $3.69), Apple Juice (38059043993, $2.69), Ketchup Packet (38059044046, free), condiment sauces ($0.59 each)
