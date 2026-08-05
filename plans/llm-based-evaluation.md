# Natural Language Policy Evaluation for Latchkey

## Context

Latchkey's permission system (Detent) uses static JSON Schema rules to allow/deny HTTP requests. This works well for structural policies ("only GET on Slack") but can't express policies that require judgment or runtime state ("don't post anything rude", "no more than 5 calls/minute"). The goal is to let users express policies in natural language. If the policy is expressible as Detent rules, compile it for the fast deterministic path. If not, store it for evaluation by a small judge model at runtime, running in series after Detent (Detent denies first, then the judge can additionally deny).

## Architecture

```
latchkey policy add "only read from Slack"
        │
        ▼
   ┌─────────────┐
   │  llm CLI     │  (classification + compilation)
   └─────┬───────┘
         │
    ┌────┴────┐
    │compilable│
    ├─yes─────┤──────► merge into permissions.json (Detent rules)
    └─no──────┘──────► store in policies.json (refined text)

latchkey curl https://slack.com/api/chat.postMessage ...
        │
        ▼
   ┌──────────┐
   │  Detent   │  deny? ──► DENIED
   └────┬─────┘
        │ allow
        ▼
   ┌──────────────┐
   │ Judge (llm)  │  deny? ──► DENIED
   │ per policy   │
   └────┬────────┘
        │ all allow
        ▼
      ALLOWED
```

## New Files

| File | Purpose |
|---|---|
| `src/llmRunner.ts` | Thin wrapper for shelling out to `llm` CLI |
| `src/policyStore.ts` | CRUD for `~/.latchkey/policies.json` (Zod-validated) |
| `src/policyCompiler.ts` | NL → Detent compilation (or refined text for judge) |
| `src/judgeEvaluator.ts` | Runtime evaluation of judge policies against a request |
| `src/requestLog.ts` | Rolling log of recent requests (context for judge) |
| `tests/` for each | Mocked `llm` runner, same patterns as existing tests |

## Modified Files

| File | Change |
|---|---|
| `src/cliCommands.ts` | Add `policy add/list/remove` subcommands; add `runLlm` to `CliDependencies` |
| `src/permissions.ts` | Add `checkPermissionWithJudge()` composing Detent + judge |
| `src/curlInjection.ts` | Expand `CurlInjectionDependencies` to carry judge-related paths |
| `src/config.ts` | Add `llmCommand`, `llmModel`, `policiesPath`, `requestLogPath` |
| `src/configDataStore.ts` | Add `llmCommand`/`llmModel` to `SettingsSchema` |
| `src/errorMessages.ts` | Add judge-specific messages |

## Key Design Decisions

### 1. Separate `policies.json` from `permissions.json`

Detent owns `permissions.json`; mixing NL policies would break its parser. Clear separation also signals which policies are deterministic vs model-evaluated.

### 2. `llm` CLI as the model backend

Shell out to Simon Willison's [`llm`](https://github.com/simonw/llm) tool. Users configure their model/provider via `llm`'s own plugin system (OpenAI, Anthropic, Gemini, local models, etc.). Latchkey config just has `llmCommand` (default `"llm"`) and `llmModel` (optional override). This avoids latchkey maintaining its own provider integrations.

### 3. Coherent Extrapolation at add-time, not runtime

When a policy can't compile to Detent, the LLM refines it into precise, unambiguous language. The user reviews and approves the refined text before storage. This avoids re-interpreting vague language on every request and gives the user control over what the judge actually enforces.

### 4. Judge evaluates each policy independently; deny if ANY denies

Secure-by-default. One restrictive policy can't be overridden by a permissive one.

### 5. `CliDependencies.checkPermission` signature stays unchanged

The judge composition is hidden inside `createDefaultDependencies()` as a closure. Existing tests don't break.

### 6. `llm` is optional; feature degrades gracefully

If `llm` isn't installed, `policy add` fails with a clear error. If no judge policies exist, runtime is zero-overhead (no `llm` call). The compiled Detent path works without `llm` at runtime.

## policies.json Schema

```json
{
  "policies": [
    {
      "id": "a1b2c3d4",
      "originalText": "don't allow more than 5 calls per minute to Slack",
      "refinedText": "Deny any request to slack.com if more than 5 requests to slack.com appear in the recent request history within the last 60 seconds.",
      "createdAt": "2026-04-30T12:00:00Z"
    }
  ]
}
```

## CLI Commands

- `latchkey policy add "<natural language>"` — classify via `llm`, compile or store
- `latchkey policy list` — show both Detent rules and judge policies
- `latchkey policy remove <id>` — remove a judge policy (for compiled rules, user edits `permissions.json` directly)

## `policy add` Flow

1. Check `llm` is installed (`llm --version`).
2. Call `compilePolicy()` with the user's text.
3. **If compilable**: show generated schemas/rule + explanation → user confirms → merge into `permissions.json`.
4. **If not compilable**: show refined text + explanation → user confirms → store in `policies.json`.

## Runtime Judge Flow (in `checkPermissionWithJudge`)

1. Run existing `checkPermission()` (Detent). If denied → return false.
2. Load `policies.json`. If empty → return true (zero overhead).
3. Parse curl args into a request description.
4. Load rolling request log for context.
5. For each judge policy, call `llm` with a judge prompt containing the policy, request details, and recent history.
6. If any policy denies → return false. Otherwise → return true.
7. Append this request to the rolling log.

## How Detent Works (background)

Detent decomposes HTTP requests into a canonical form (`protocol`, `domain`, `port`, `path`, `method`, `headers`, `queryParams`, `body`) and validates them against JSON Schema (2020-12) rules. Each rule maps a **scope** schema (which request domain/pattern does this apply to?) to **permission** schemas (what's allowed within that scope?). Rules evaluate top-to-bottom; first matching scope wins. The compilation prompt needs to teach the LLM this vocabulary so it can generate valid schemas.

## Implementation Order

1. `src/llmRunner.ts` — subprocess wrapper, `LlmRunner` type, error classes
2. `src/policyStore.ts` — Zod schema, load/add/remove for `policies.json`
3. `src/requestLog.ts` — rolling log append/load
4. Config changes in `src/config.ts` + `src/configDataStore.ts`
5. `src/policyCompiler.ts` — compilation prompt + classification logic
6. `src/judgeEvaluator.ts` — runtime judge prompt + evaluation
7. CLI commands in `src/cliCommands.ts`
8. Series composition in `src/permissions.ts`
9. Tests for each module

## Verification

- Unit tests with mocked `LlmRunner` for all new modules
- Manual test: `latchkey policy add "only allow GET requests"` → verify it compiles to Detent
- Manual test: `latchkey policy add "no more than 3 calls per minute"` → verify stored as judge policy
- Manual test: `latchkey curl` with judge policies → verify `llm` is called and deny works
- Existing permission tests still pass unchanged
