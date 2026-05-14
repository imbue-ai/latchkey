# DoorDash Latchkey Curl API — Cheatsheet

Quick index of all tested API flows. Each entry links to the full curl command and notes in WORKLOG.md.

## Common Setup

```bash
export LATCHKEY_CURL=/Users/bowei/code/latchkey/ws-002/tools/curl_chrome136
```

Every call needs: `-H 'Content-Type: application/json' -H 'Accept: application/json'`

All queries must be **fully inline** (no `operationName`/`variables`). Enum values **unquoted**.

---

## Queries (read-only)

| Action | Operation | WORKLOG Section | Key Notes |
|---|---|---|---|
| List all carts | `listCarts` | #1 | Use `restaurant.business.name` (not `restaurant.name`) |
| Search restaurants | `autocompleteFacetFeed` | #2 | Store ID in `click.data` JSON |
| Consumer identity + address | `consumer` | #3 | `defaultAddress` = delivery address for all carts |
| Checkout preview | `orderCart` | #3b | Cart must have items; shows total with fees/tax |
| Store menu | `storepageFeed` | #4 | Check `quickAddContext.isEligible` for simple adds |
| Item details + options | `itemPage` | #5 | **Route through `/graphql/consumer`** — `/graphql/itemPage` is 403 |
| Order history | `getConsumerOrdersWithDetails` | (tested inline) | Has `cancelledAt` field for cancelled orders |
| Order history + status | `getConsumerOrdersWithDetails` | #14 | `cancelledAt` for status, `paymentCard.last4`, `deliveryUuid` |
| Preview cancellation | `previewOrderCancellation` | #11 | Read-only, same response as actual cancellation |
| List saved addresses | `getAvailableAddresses` | #17 | Returns all addresses on account (33 on test acct) |

## Mutations (modify state)

| Action | Operation | WORKLOG Section | Key Notes |
|---|---|---|---|
| Create new cart | `addCartItemV2` | #6 | Pass `cartId: ""` to create new cart |
| Add item to existing cart | `addCartItemV2` | #7 | Pass existing `cartId`; items preserved |
| Add item with options | `addCartItemV2` | #8 | `nestedOptions` is JSON string with `itemExtraOption` wrapper |
| Delete entire cart | `deleteCart` | #9 | Returns `true` on success |
| Place order | `createOrderFromCart` | #10 | `deliveryTime: "ASAP"` required; returns `orderUuid` |
| Cancel order | `orderCancellation` | #11 | Uses `orderUuid` not `cartId`; statusCode 1 = real cancel |
| Remove single item | `removeCartItemV2` | #12 | Uses orderItem UUID (not catalog item ID) |
| Change delivery address | `updateConsumerDefaultAddress` | #17 | `defaultAddressId: ID!` — swaps account-level default |

## Not Yet Tested

| Action | Likely Mutation | Status |
|---|---|---|
| Update item quantity | `updateCartItemV2` | **Broken** — returns null. Workaround: remove (#12) + re-add (#7) |
| Order tracking | `orderTracker` | Fields undiscoverable — use `getConsumerOrdersWithDetails` (#14) instead |
| Tip at order time | `createOrderFromCart` `tipAmounts` | Set at order creation (#16), no post-order tip mutation |
| Change delivery address | `updateConsumerDefaultAddress` | **Tested** — see Mutations table + WORKLOG #17 |
| Apply promo/coupon | unknown | Not started |
| Reorder previous order | unknown | Not started |
| Switch pickup/delivery | unknown | Not started |

## Reference Data

| Restaurant | storeId | menuBookId |
|---|---|---|
| Sweetgreen (171 2nd St, SF) | 65695 | 34497946 |
| McDonald's (SF) | 653630 | 90095146 |
| Starbucks (SF) | 36737969 | 82815346 |

## Key Pitfalls (see HICCUPS.md for full details)

1. **Inline queries only** — `operationName` + `variables` = 400 every time
2. **`/graphql/itemPage` blocked** — route through `/graphql/consumer` instead
3. **Enum values unquoted** — `Delivery` not `"Delivery"`, `contact` not `"contact"`
4. **`nestedOptions` format** — needs `{itemExtraOption: {id, name, price}, id, quantity, options: []}`
5. **All required option groups** — partial selections fail silently
6. **`deliveryTime: "ASAP"`** — empty string causes scheduled delivery error
7. **Cart GC aggressive** — create and use immediately
