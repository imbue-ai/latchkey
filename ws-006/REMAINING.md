# Remaining Open Questions & Next Steps

## Solid / fully tested:
- All 6 original INSTR flows (fetch carts, search restaurants, item details, create cart, add item, add item with options)
- `createOrderFromCart` — placed real order with `deliveryTime: "ASAP"`, got orderUuid back
- `orderCancellation` — cancelled real order, statusCode=1, partial refund ($5.49 on $10.74)
- `previewOrderCancellation` — read-only preview, same response shape as actual cancellation
- `deleteCart` — returns true
- `removeCartItemV2` — uses orderItem UUID, returns updated OrderCart
- `getConsumerOrdersWithDetails` — `cancelledAt`, `paymentCard`, `deliveryUuid`, `fulfillmentType`
- Inline-only query constraint, Cloudflare endpoint blocking + workaround, enum quoting, nestedOptions format

## Actionable next steps (ready to test):

### 1. Change delivery address
- **Risk**: Tricky — could break active orders or affect account state
- **Approach**: Probe for `updateDefaultAddress`, `setDeliveryAddress`, `updateConsumerAddress` mutations. Check `getAvailableAddresses` query first to see stored addresses.
- **Status**: Held pending user go-ahead

### 2. Test `getAvailableAddresses` and `getPaymentMethodList` end-to-end
- Both returned 200 status but response data never inspected
- Low risk, read-only queries

### 3. Apply promo/coupon code
- Unknown mutation name — need to probe (`applyPromo`, `addPromoCode`, `applyCoupon`, etc.)
- May be part of checkout flow rather than standalone

### 4. Reorder a previous order
- Unknown mutation — could be `reorder`, `reorderFromOrder`, etc.
- May just be a convenience wrapper that adds items from a past order to a new cart

### 5. Switch pickup vs delivery on existing cart
- `fulfillmentType` exists as enum (Delivery/Pickup)
- May be part of `updateCart` or a separate mutation

## Open questions (not easily actionable):

1. **Why operationName+variables gives 400** — CycleTLS uses that format fine. Missing header? Request body encoding? Content-Length? Root cause unknown, just worked around.

2. **nestedOptions for complex items** — minimal `{itemExtraOption: {id, name, price}}` works for simple options but Starbucks (4+ required nested groups) failed. Unknown if more fields needed or if it's a nesting depth issue.

3. **Which other endpoints are Cloudflare-blocked** — only ~9 paths tested. Could be more 403s.

4. **`updateCartItemV2` is broken** — returns null, no effect. Confirmed by doordash-mcp. Workaround: remove + re-add.

5. **Partial refund on cancellation** — $5.49 refund on $10.74 order. Fees likely not refunded but exact breakdown unclear.

6. **`orderTracker` fields undiscoverable** — query exists, returns `OrderTrackerResponse`, but ~50 field names probed with zero suggestions. Likely server-driven UI. Need network traffic capture from DoorDash web client.

7. **`deliveryAddress.formattedAddress` always null** — on `getConsumerOrdersWithDetails`. `ConsumerOrderDeliveryAddress` only has `id` reliably.

8. **No post-delivery tip adjustment** — tip set at order creation via `tipAmounts` in `createOrderFromCart`. No standalone mutation. Post-delivery tipping likely mobile-app only.
