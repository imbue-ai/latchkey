# Branch Split Execution Plan

## Branches

### 1. `bowei/cycletls-transport` (park — not submitting now)
New branch off `main` in a worktree. Contains cycletls infrastructure only.

**Files from main + these changes:**
- `package.json` — add cycletls optional dep
- `src/cycletls.d.ts` — type declarations
- `src/cycleTlsTransport.ts` — transport implementation
- `src/services/core/base.ts` — `transport` property on Service, cycletls path in `checkApiCredentials`
- `src/curlInjection.ts` — `CurlInvocationResult` type, transport plumbing
- `src/cliCommands.ts` — cycletls execution path
- `src/gateway/gatewayEndpoint.ts` — cycletls execution path

Does NOT include: `prepareContext` hook, doordash service, or any ws-*/spike files.

### 2. `bowei/doordash-clean` (the PR)
New branch off `main` in a worktree. Contains DoorDash service only.

**Files from main + these changes:**
- `src/services/core/base.ts` — `prepareContext` hook on ServiceSession (no transport property, no cycletls)
- `src/services/doordash.ts` — service, credentials, session
- `src/services/index.ts` — export DOORDASH
- `src/serviceRegistry.ts` — register DOORDASH
- `src/apiCredentials/serialization.ts` — DoorDash schema + ser/deser
- `tests/apiCredentials.test.ts` — DoorDash credential tests

Does NOT include: cycletls anything, ws-*/spike files, transport property, CurlInvocationResult changes.

### 3. `bowei/doordash` (this repo — DO NOT TOUCH)
Current working copy. Reference only. Abandon after `doordash-clean` is verified.

## Execution

1. Create worktree for `bowei/cycletls-transport` off `main`
2. Copy/cherry-pick cycletls files into it, commit
3. Create worktree for `bowei/doordash-clean` off `main`
4. Copy DoorDash files into it, commit
5. In `doordash-clean` worktree: run tests, type check, verify `auth browser doordash` works
6. If green, that's the PR branch
