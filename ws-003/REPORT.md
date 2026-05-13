# Report: CycleTLS Transport Integration

## What was done

Added CycleTLS as an alternative HTTP transport in latchkey for services behind Cloudflare TLS fingerprinting (DoorDash). The integration follows latchkey's existing architecture — services opt in via a `transport` property, and the existing curl argument pipeline (permissions, URL extraction, credential injection) runs unchanged. At the execution step, the transport switches from spawning curl to calling CycleTLS with a Chrome JA3 fingerprint.

### Files created
- `src/cycleTlsTransport.ts` — Lazy-loaded CycleTLS wrapper with curl-arg-to-HTTP translation
- `src/cycletls.d.ts` — Type declarations for the optional cycletls package

### Files modified
- `src/services/core/base.ts` — Added optional `transport` property, CycleTLS path in `checkApiCredentials`
- `src/services/doordash.ts` — Set `transport = 'cycletls'`
- `src/curlInjection.ts` — Changed `prepareCurlInvocation` return type to include transport hint
- `src/cliCommands.ts` — `latchkey curl` uses CycleTLS when service transport is cycletls
- `src/gateway/gatewayEndpoint.ts` — Gateway proxy uses CycleTLS directly (no temp files)
- `package.json` — Added `cycletls@^2.0.5` as optional dependency

## Hiccups

1. **Sync vs async mismatch**: `CapturingSubprocessRunner` is synchronous but CycleTLS is inherently async. Solved by handling CycleTLS at a higher level (`checkApiCredentials` is already async, CLI/gateway callers are async) rather than trying to make it fit the subprocess runner interface.

2. **Mock objects in tests**: Adding `transport` as a required property broke ~10 test mock objects that implement `Service`. Fixed by making `transport` optional (`transport?: 'curl' | 'cycletls'`) and using `?? 'curl'` at the one place that needs a concrete value.

3. **Lint strictness**: First version used `any` types for the CycleTLS instance. The codebase has strict `@typescript-eslint/no-unsafe-*` rules. Fixed by creating a proper `.d.ts` with typed interfaces and deriving the client type via `Awaited<ReturnType<typeof initCycleTLS>>`.

4. **DoorDash `checkApiCredentials` override**: DoorDash has a custom override that parses GraphQL JSON rather than just checking HTTP 200. This override still uses `runCaptured` (curl), so credential validation is still broken for DoorDash. The `latchkey curl` and gateway paths work. This gap was documented in PR.md.

## Recommendations for next time

1. **The curl-args roundtrip is the core awkwardness.** Latchkey builds curl argument arrays, then for CycleTLS we parse them back into HTTP semantics. A cleaner long-term approach would be an `HttpRequest` abstraction that both transports consume, with credential injection producing `HttpRequest` objects instead of curl args. But that's a big refactor and not worth it for one service.

2. **`parseCurlArgsToHttp` is a simplified parser.** It handles the flags latchkey actually uses (`-X`, `-H`, `-d`, `--data-binary @-`, `-o`, `-w`, `-D`, `-s`) but not the full curl flag vocabulary. If more services adopt CycleTLS with exotic curl args, this parser may need expanding. Could potentially reuse `parseCurlArgs` from `@imbue-ai/detent` (which already returns a `Request` object) instead of rolling our own — worth investigating. I didn't use it because the `Request` object from detent doesn't preserve the raw body string (it creates a proper `Request` with a readable body stream), and the output flags (`-o`, `-w`, `-D`) aren't part of HTTP semantics so detent doesn't parse them.

3. **Having the doordash-mcp reference implementation was invaluable.** The Chrome JA3 string, User-Agent, and CycleTLS API patterns came directly from `~/code/doordash-mcp/ws-005`. Without that working example, figuring out the right JA3 and CycleTLS invocation would have been trial-and-error. For future integrations, having a working reference in a simpler codebase first makes the real integration much smoother.

4. **The `CONTEXT.md` upfront was helpful.** It laid out the problem, root cause, and options clearly, which saved a lot of exploration time. Good pattern for complex tasks.
