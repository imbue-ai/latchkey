# Task: Test Change Delivery Address

## Goal
Discover and test how to change the delivery address via the DoorDash GraphQL API.

## Current state
- Default address is `292 Ivy St, San Francisco, CA 94102` (from `consumer { defaultAddress }`)
- Delivery address is account-level, not per-cart (see HICCUPS.md #10)
- `getAvailableAddresses` endpoint returns 200 but response data never inspected

## Plan

### Phase 1: Read-only recon (safe)
1. Query `getAvailableAddresses` to see what addresses are on file
2. Query `consumer { defaultAddress { id street city state zipCode } }` to confirm current default
3. Probe `ConsumerAddress` type fields via error messages

### Phase 2: Discover mutation (safe — just probing names)
Probe candidates:
- `updateDefaultAddress`
- `setDefaultAddress`
- `updateConsumerAddress`
- `setDeliveryAddress`
- `updateAddress`
- `addAddress`
- `saveAddress`
- `selectAddress`

### Phase 3: Test mutation (RISKY — changes account state)
- **Before**: Record current default address ID
- **Change to**: Another address already on file (from Phase 1), NOT a new address
- **Immediately revert**: Change back to original address ID
- **Verify**: Query `consumer { defaultAddress }` to confirm revert

## Risks
- Changing address could affect all active carts and in-flight orders
- If revert fails, deliveries could go to wrong address
- Account may have address validation that rejects changes
- Could trigger re-pricing of active carts (delivery fees change by distance)

## Abort conditions
- If no mutation is discoverable, stop — document findings
- If mutation exists but requires fields we can't determine, stop
- If Phase 1 shows only one address on file, skip Phase 3 (no safe address to swap to)
- If any active orders are in-flight, DO NOT test Phase 3

## Success criteria
- Know the mutation name and required args
- Successfully swap address and swap back
- Document in WORKLOG, HICCUPS, CHEATSHEET
