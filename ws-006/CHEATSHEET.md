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
| Preview cancellation | `previewOrderCancellation` | #11 | Read-only, same response as actual cancellation |

## Mutations (modify state)

| Action | Operation | WORKLOG Section | Key Notes |
|---|---|---|---|
| Create new cart | `addCartItemV2` | #6 | Pass `cartId: ""` to create new cart |
| Add item to existing cart | `addCartItemV2` | #7 | Pass existing `cartId`; items preserved |
| Add item with options | `addCartItemV2` | #8 | `nestedOptions` is JSON string with `itemExtraOption` wrapper |
| Delete entire cart | `deleteCart` | #9 | Returns `true` on success |
| Place order | `createOrderFromCart` | #10 | `deliveryTime: "ASAP"` required; returns `orderUuid` |
| Cancel order | `orderCancellation` | #11 | Uses `orderUuid` not `cartId`; statusCode 1 = real cancel |

## Not Yet Tested

| Action | Likely Mutation | Status |
|---|---|---|
| Remove single item from cart | `removeCartItemV2` | Pending |
| Update item quantity | `updateCartItemV2` | Pending |
| Order tracking | unknown | Pending |
| Tip adjustment | unknown | Pending |
| Change delivery address | unknown | Pending (tricky) |
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
