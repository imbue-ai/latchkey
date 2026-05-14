# DoorDash Browser Auth Repeat Login Bug — Report

## Problem

`latchkey auth browser doordash` works on first run but fails on subsequent runs. Browser state (cookies) persists across sessions via encrypted storage, causing stale cookies to be returned instead of fresh ones.

## Root Cause

Two interacting mechanisms:

1. **`withTempBrowserContext`** restores encrypted browser state (cookies, localStorage) from previous sessions into the new browser context. This is useful for services like Google where persistent state helps, but harmful for DoorDash where we always want a fresh login.

2. **Fallback cookie-polling in `onResponse`** (lines 98-110 of doordash.ts) checks `context.cookies()` on every doordash.com response. On second login, the old `ddweb_token` is already in the cookie jar from restored state, so it immediately fires `loginComplete = true` — returning stale (possibly expired) cookies without ever showing the user a login page.

## Fix

Two files changed:

- **`src/services/core/base.ts`** — Added `prepareContext(context: BrowserContext)` hook to `ServiceSession` base class. Called before `page.goto(loginUrl)`. Default is no-op. This is a general-purpose extension point any service can use.

- **`src/services/doordash.ts`** — Override `prepareContext` to call `context.clearCookies({ domain: /doordash\.com/ })`. Clears all DoorDash cookies from restored browser state before navigating to login. Forces a fresh login every time.

Also fixed pre-existing lint errors (empty catch callbacks, unnecessary condition, unsafe `any` from `JSON.parse`).

## Hiccups

- The linter auto-modified the file between reads (removed `override readonly transport = 'cycletls'`, replaced with a TODO comment). Had to re-read before editing. Minor friction, just need to always re-read after lint runs.

## Recommendations for Next Time

1. **Browser state persistence is a footgun for cookie-based auth.** Any service that extracts cookies via browser login should clear its domain's cookies in `prepareContext`. Consider making this the default behavior — or at minimum, document this pattern for future service authors.

2. **The fallback cookie-polling pattern (checking `context.cookies()` in `onResponse`) is fragile with persistent state.** It was added to handle edge cases where the `set-cookie` header detection misses, but it interacts badly with restored browser state. The `prepareContext` cookie-clearing fix makes them safe to coexist, but future services should be aware.

3. **Playwright's `clearCookies({ domain: regex })` is the right tool** for selectively clearing cookies. Available since Playwright 1.38+. No need to manually iterate and delete.

4. **Alternative approach considered:** Could have skipped `browserStatePath` entirely for DoorDash (not passing it in launch options). But that would require service-level control over launch options, which doesn't exist in the current architecture. The `prepareContext` hook is cleaner and more general.
