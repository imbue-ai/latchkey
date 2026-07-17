/**
 * Account identifiers for stored credentials.
 *
 * An account is a string that uniquely identifies the account behind a set of
 * credentials (typically an e-mail, sometimes an opaque id). The empty string
 * denotes the "default" account.
 *
 * This lives in its own leaf module (with no other imports) so that service
 * implementations can reference the default account without importing the
 * credential store, which would create an import cycle
 * (store -> serialization -> service -> core/base -> store).
 */

export const DEFAULT_ACCOUNT = '';
