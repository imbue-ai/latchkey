# Remaining Open Questions

## Solid / fully tested:
- All 6 INSTR flows work end-to-end
- Inline-only query constraint documented
- Cloudflare endpoint blocking + workaround
- Enum quoting pitfall
- Basic nestedOptions format

## Still unclear:

1. **Why operationName+variables gives 400** — CycleTLS uses that format fine. Is it a missing header? A request body encoding difference? Content-Length? Haven't root-caused this, just worked around it.

2. **nestedOptions for complex items** — minimal `{itemExtraOption: {id, name, price}}` worked for Sweetgreen's optional toppings. But Starbucks (4+ required nested option groups with nested-inside-nested) failed with internal-server-error. Don't know if the format needs more fields (`itemExtraId`, `categoryId`, etc.) or if it's a nesting depth issue.

3. **Which other endpoints are Cloudflare-blocked** — only tested ~9 paths. Could be more 403s hiding (e.g. `removeCartItemV2`, `updateCartItemV2`, checkout-related ones).

4. **Order history / account queries** — never actually tested `getConsumerOrdersWithDetails`, `getAvailableAddresses`, `getPaymentMethodList` end-to-end (just confirmed 200 status codes, didn't check response data).

5. **Mutations beyond add/delete** — `updateCartItemV2` (change quantity), `removeCartItemV2` (remove single item) untested.
