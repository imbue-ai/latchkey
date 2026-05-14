# ws-005 Report: Final E2E Testing + Branch Split

## What was done

1. **E2E tested both login flows** on `bowei/doordash` branch:
   - Fresh login: browser opens DoorDash login, user authenticates, cookies captured, `auth list` shows valid, API calls return real data (order history, consumer profile)
   - Relogin: browser shows login page again (not stale cookies), credentials valid after re-auth
   - API verification: GraphQL queries to `getConsumerOrdersWithDetails` and `consumer` both return real data

2. **Tested CycleTLS as alternative to curl-impersonate** — does not work:
   - CycleTLS gets 403 from DoorDash's Cloudflare even with Chrome JA3 fingerprint
   - Likely cause: Cloudflare checks more than JA3 (JA4, HTTP/2 fingerprint, TLS extension ordering). CycleTLS only spoofs cipher suites.
   - Additional issue: CycleTLS Go binary doesn't exit cleanly, hangs `auth list` indefinitely
   - curl-impersonate (`curl_chrome136`) works because it's a patched libcurl matching Chrome's full TLS+HTTP/2 behavior
   - Full findings in `CYCLETLS_FINDINGS.md`

3. **Split branch into clean worktrees:**
   - `bowei/cycletls-transport` at `latchkey-cycletls/` — parked, cycletls infra only (8 files)
   - `bowei/doordash-clean` at `latchkey-doordash-clean/` — PR-ready, DoorDash service only (6 files)
   - `bowei/doordash` — original branch, untouched as reference

4. **Verified doordash-clean independently** — built with `node dist/src/cli.js` (not global `npx latchkey`), all flows pass: auth list, fresh login, relogin, API calls.

## Hiccups

- **Stale dist build:** After backing out cycletls from doordash.ts source, forgot to rebuild. `npx latchkey` uses compiled JS in `dist/`, so it was still running the old code with cycletls enabled. Showed "invalid" until rebuild.
- **CycleTLS Go binary lingering:** After a debug test, the Go subprocess kept running and caused subsequent `auth list` commands to hang. Had to `pkill` it manually.
- **TypeScript execution for debugging:** Couldn't easily run `.ts` files directly — project uses ESM, no ts-node installed, tsx had top-level await issues. Had to `npm run build` first and test against `dist/`.

## Recommendations for next time

1. **Always rebuild after source changes** when testing via `npx latchkey` or `node dist/src/cli.js`. Easy to forget and debug phantom issues from stale dist.

2. **CycleTLS is not a viable replacement for curl-impersonate** against aggressive Cloudflare setups. Don't spend time trying to make it work for DoorDash-like sites. The JA3-only spoofing approach is outdated for modern bot detection.

3. **Worktree-based branch splitting works well.** Avoids checkout switching, keeps the working installation intact. Pattern: create worktree off main, apply patches with `git diff main...HEAD -- file | (cd worktree && git apply -)`, verify independently.

4. **The `prepareContext` hook pattern is worth documenting for future service authors.** Any service that captures cookies via browser login should clear its domain's cookies in `prepareContext` to prevent the relogin bug. Could be mentioned in a contributing guide or base class docstring.

5. **curl-impersonate distribution:** Currently the binary lives in `ws-002/tools/` and requires `LATCHKEY_CURL` env var. For production use, should consider: bundling it, documenting setup, or auto-detecting it. Users won't know to set this env var without docs.
