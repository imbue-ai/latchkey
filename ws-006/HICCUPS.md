# DoorDash API Hiccups & Pitfalls

Every mistake, dead end, and surprise encountered during testing — so you don't repeat them.

---

## 1. operationName + variables = 400 Bad Request

**What happened**: Standard GraphQL request format with `operationName`, `variables`, and parameterized `query` returns 400 on every endpoint.

```json
// THIS DOES NOT WORK
{"operationName":"listCarts","variables":{"input":{...}},"query":"query listCarts($input: ListCartsInput!) { ... }"}
```

**What works**: Fully inline queries with no `operationName` or `variables` fields.
```json
{"query":"{ listCarts(input: {cartContextFilter: ...}) { ... } }"}
```

**Attempts that didn't help**:
- Adding `apollographql-client-name: @doordash/app-consumer-production-ssr-client` header
- Adding `apollographql-client-version: 3.0` header
- Removing `operationName` but keeping `variables`
- Keeping `operationName` but removing `variables`

**Mystery**: CycleTLS (in doordash-mcp/ws-005/test.mjs) uses operationName+variables and it works fine. Root cause unknown — could be a header diff, TLS fingerprint diff, or request encoding diff.

---

## 2. `/graphql/itemPage` returns 403 (Cloudflare)

**What happened**: Any request to `https://www.doordash.com/graphql/itemPage` returns a 403 HTML page from Cloudflare, regardless of payload.

**What we tried**:
- curl_chrome136, curl_chrome142, curl_chrome146 — all 403
- Sending a dummy `{"query":"{ consumer { id } }"}` payload — still 403
- Removing `?operation=itemPage` query param — still 403

**What works**: Send the itemPage query through a different URL path:
```
https://www.doordash.com/graphql/consumer?operation=itemPage
```
DoorDash's GraphQL resolver doesn't care about the URL path — it routes based on the query content. Only Cloudflare uses the path for blocking.

**Other blocked endpoints**: Unknown. Only `/graphql/itemPage` was found blocked out of 9 tested. See WORKLOG.md for full table.

---

## 3. Enum values quoted as strings = validation error

**What happened**: In inline GraphQL, writing `substitutionPreference: "contact"` or `fulfillmentType: "Delivery"` causes:
```
Enum "SubstitutionPreference" cannot represent non-enum value: "contact". Did you mean the enum value "contact"?
Enum "FulfillmentType" cannot represent non-enum value: "Delivery". Did you mean the enum value "Delivery"?
```

**Why**: In GraphQL, enum values are unquoted. Quotes make them strings. With the variables format you pass strings that get coerced, but in inline mode the parser is strict.

**Fix**: `substitutionPreference: contact` (no quotes), `fulfillmentType: Delivery` (no quotes).

---

## 4. nestedOptions: wrong format = silent internal-server-error

**What happened**: Tried adding item with options using simple format:
```json
[{"id":"51342150685","quantity":1}]
```
Got `internal-server-error` (gRPC code 13) with empty message. No hint about what's wrong.

**What works**: The full `itemExtraOption` wrapper format:
```json
[{
  "itemExtraOption": {"id": "OPTION_ID", "name": "Name", "price": 75},
  "id": "OPTION_ID",
  "quantity": 1,
  "options": []
}]
```

**How we figured it out**: Queried existing cart items via `listCarts` with the `nestedOptions` field to see the format DoorDash stores and returns.

**Minimum required fields**: `itemExtraOption.id`, `itemExtraOption.name`, `itemExtraOption.price`, top-level `id`, `quantity`, `options`. Other fields like `itemExtraId`, `merchantSuppliedItemId`, `itemExtraMerchantSuppliedId` are optional.

---

## 5. Required option groups must ALL be satisfied

**What happened**: Adding a Starbucks Grande Latte with just the Size option selected. Got past size validation but then:
```
Please select at least 1 options for Espresso Roast Options (Add Espresso Shot Above)
```

**Why**: Starbucks Caffe Latte has 4 required nested option groups under each size: Espresso Shots, Espresso Roast, Milk Temperature, Milk Options. Providing just one required group is not enough.

**Lesson**: Always check `isOptional` on every `optionList` (and nested `nestedExtrasList`). All groups with `isOptional: false` must have selections. Some items (Starbucks drinks) have deeply nested required options making them impractical to add via API without mapping the full option tree.

---

## 6. `restaurant.name` is always null

**What happened**: `listCarts` query returning `restaurant { name }` gives null for every cart.

**Fix**: Use `restaurant { business { name } }` instead. The `name` field on `restaurant` appears to be deprecated or unpopulated; the actual name lives on the nested `business` object.

---

## 7. GraphQL introspection is disabled

**What happened**: Tried `__type(name: "OrderCart")` introspection to discover field names:
```
GraphQL introspection is not allowed by Apollo Server, but the query contained __schema or __type.
```

**Implication**: Can't discover schema dynamically. Must rely on:
- Error messages (which suggest valid field names like "Did you mean...")
- The doordash-mcp query files as reference
- Trial and error

---

## 8. Item not found — storeId/itemId mismatch

**What happened**: Used itemId from `autocompleteFacetFeed` search for one Starbucks location against a different Starbucks storeId:
```
9 FAILED_PRECONDITION: [fetchItemData] Item not found. itemId:48001744862, storeId:36737969
```

**Why**: Item IDs are store-specific. Same menu item (e.g. "Caffe Latte") has different IDs at different locations. Must get item IDs from `storepageFeed` for the specific storeId you're working with.

---

## 9. curl_chrome136 sends browser-default headers

**What happened**: Without explicit `-H 'Accept: application/json'`, curl_chrome136 sends:
```
Accept: text/html,application/xhtml+xml,application/xml;q=0.9,...
```
This causes some endpoints to return HTML instead of JSON.

**Fix**: Always include both:
```
-H 'Content-Type: application/json' -H 'Accept: application/json'
```

---

## 10. Delivery address is NOT per-cart — it's account-level

**What happened**: Tried multiple approaches to find which address a cart delivers to:

1. `orderCart { deliveries { address { printableAddress } } }` → `Cannot query field "address" on type "Delivery"`. Delivery type only has `id` and `quotedDeliveryTime`.
2. `orderCart { deliveryAddress { ... } }` → `Cannot query field "deliveryAddress"`. Suggested: `deliveries`, `deliveryFee`, `deliveryOptions`.
3. `orderCart { budgetAddress { ... } }` → `Cannot query field "budgetAddress"`. That field lives on `ExpenseOrderBudget`, a corporate expense fragment, not OrderCart.
4. `orderCart { expandAddressDetails }` → returns `false` (a boolean flag, not an address).
5. `orderCart { deliveryOptions { ... } }` → empty array `[]`.
6. `orderCart { deliveryFee deliveryFeeDetails { ... } deliveries selectedDeliveryOption }` → all null.

**Resolution**: Delivery address lives on the consumer, not the cart:
```graphql
{ consumer { defaultAddress { id street city state zipCode } } }
```
Returns `292 Ivy St, San Francisco, CA 94102`. All carts deliver to this address.

---

## 11. Empty carts return CART_NOT_FOUND on orderCart

**What happened**: Queried `orderCart(id: "83fce989-5765-...")` on an empty Starbucks cart:
```
CART_NOT_FOUND: [createParticipantCart] Cart for cartUuid=83fce989-5765-... consumerId=895291629
```

Also, the cart UUID had changed between `listCarts` calls (`83fce989-5765-...` → `83fce989-d014-...`) — DoorDash may recycle/regenerate cart IDs for empty carts.

**Fix**: Add an item first, then query. Empty carts can't be previewed via orderCart.

---

## 12. `consumerOrderCart` returns "current" cart, not a specific one

**What happened**: Tried `consumerOrderCart` (no ID param) hoping to get cart details:
```graphql
{ consumerOrderCart { id restaurant { business { name } } deliveries { ... } } }
```
Returns the most recent/active cart (Komeya no Bento), not the one you want. No way to pass a cart ID to this query — it's always the "current" cart. Use `orderCart(id: "...")` for specific carts.

---

## 13. `latchkey curl` service name is URL-based, not positional

**What happened**: Tried `npx latchkey curl -s doordash -X POST ...` — got "No service matches URL: doordash".

**Fix**: Don't pass a service name. Latchkey matches by URL pattern automatically. Just pass the DoorDash URL directly:
```
npx latchkey curl -s -X POST ... 'https://www.doordash.com/graphql/...'
```

---

## 14. `orderCancellation` statusCode meanings are non-obvious

**What happened**: Called `orderCancellation(orderUuid: "fake")` — returned `statusCode: 0` with empty refund. No error. Called on real order — returned `statusCode: 1` with actual refund.

**Resolution**: `statusCode: 0` = no-op (invalid/nonexistent UUID). `statusCode: 1` = real cancellation executed. There's no error on invalid UUIDs — must check statusCode to know if anything happened.

**Refund surprise**: Real cancellation of $10.74 order refunded only $5.49. Likely only item cost refunded, not delivery/service fees.

---

## 15. `deliveryTime: ""` causes scheduled delivery error

**What happened**: `createOrderFromCart` with `deliveryTime: ""` returns:
```
Scheduled delivery must set scheduled delivery time
```

**Fix**: Use `deliveryTime: "ASAP"` for immediate delivery. Don't pass empty string or omit.

---

## 16. Cart garbage collection is aggressive

**What happened**: Created carts during testing, came back minutes later and cart UUIDs had changed or carts disappeared entirely. Empty carts especially unstable — UUIDs regenerated between `listCarts` calls.

**Lesson**: Create cart and use immediately. Don't rely on cart UUIDs persisting across long gaps. Always re-fetch via `listCarts` if unsure.

---

## 17. Schema probing technique (since introspection is disabled)

Since `__schema` / `__type` introspection is blocked, field/mutation names must be discovered by trial and error. Useful patterns:

- **Wrong field name** → error suggests alternatives: `"Did you mean \"cancelEditOrder\"?"`
- **Missing required args** → error lists them: `"argument \"editId\" of type \"String!\" is required"`
- **Wrong arg name** → error suggests: `"Did you mean \"orderUuid\"?"`
- **Valid field, needs subfields** → `"must have a selection of subfields"`
- **`__typename`** → always works, confirms a field/mutation exists and returns its type name
- **Batch probing** → loop over candidate names, check for "Cannot query field" vs other errors

---

## 18. `updateCartItemV2` silently returns null — broken mutation

**What happened**: Called `updateCartItemV2` with valid cart, store, and item IDs + new quantity. Response: `{"data":{"updateCartItemV2":null}}`. No error, no effect. Tried both orderItem UUID and catalog item ID — same result.

**Confirmation**: doordash-mcp source code comments: `// Remove then re-add (updateCartItemV2 is broken)`.

**Workaround**: Use `removeCartItemV2` to remove the item, then `addCartItemV2` with the desired quantity. If removing the last item deletes the cart, re-add with `cartId: ""`.

---

## 19. `orderTracker` response fields undiscoverable

**What happened**: `orderTracker(orderUuid: "...")` returns `OrderTrackerResponse` type successfully. But ~50 field names probed (status, eta, dasher, delivery, tracker, map, timeline, progress, body, feed, sections, etc.) — all get "Cannot query field" with zero "Did you mean" suggestions.

**Why**: GraphQL "Did you mean" only triggers for close Levenshtein-distance matches. `OrderTrackerResponse` likely uses server-driven UI pattern with unusual field names (e.g. `componentModules`, `layoutPayload`). Without introspection or network capture, these are unguessable.

**Practical workaround**: Use `getConsumerOrdersWithDetails` — has `cancelledAt` (null if not cancelled), `submittedAt`, `paymentCard`, `deliveryUuid`. No real-time tracking status though.

---

## 20. `deliveryAddress.formattedAddress` returns null on order history

**What happened**: `getConsumerOrdersWithDetails` has `deliveryAddress { id formattedAddress }` — the `id` works but `formattedAddress` always returns null.

**Why**: The `ConsumerOrderDeliveryAddress` type is different from the `consumer.defaultAddress` type. It doesn't have `street`, `city`, `state` fields either (those fail validation). Only `id` is reliably populated.
