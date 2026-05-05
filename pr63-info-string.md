# Expanding `NotionMcp.info` — does the MCP server publish HTTP docs?

Working doc for ask #3 from `pr63-asks-summary.md`.

## What Hynek asked

> The `info` string usually contains pointers to a documentation that the agent can use to be able to actually use the API. … is there a good documentation for the MCP server when you want to use it directly over http? (We generally avoid including private or undocumented APIs because agents have no way of knowing how exactly to use them.)

So the question splits into two parts:

1. Does `mcp.notion.com` itself advertise a doc link from any HTTP route? — **no** (see "Routes probed" below).
2. Is there public, unauthenticated documentation elsewhere that an agent can read to use the API? — **yes, more than expected** (see "Public docs found" below).

## Routes probed on `mcp.notion.com`

Unauthenticated `curl` against the host. Captured 2026-05-05.

| Route | Status | Notable content |
| --- | --- | --- |
| `GET /mcp` | 401 | `WWW-Authenticate: Bearer realm="OAuth", resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource/mcp", error="invalid_token"`. Body: `{"error":"invalid_token","error_description":"Missing or invalid access token"}`. No doc link. |
| `GET /sse` | 401 | Same shape as `/mcp`, with `resource_metadata=".../oauth-protected-resource/sse"`. No doc link. |
| `GET /.well-known/oauth-protected-resource/mcp` | 200 | `{"resource":"https://mcp.notion.com/mcp","authorization_servers":["https://mcp.notion.com"],"bearer_methods_supported":["header"],"resource_name":"Notion MCP (Beta)"}`. Only human-readable string is `resource_name`. No doc link. |
| `GET /.well-known/oauth-authorization-server` | 200 | RFC 8414 metadata: `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, `revocation_endpoint`, supported grants (`authorization_code`, `refresh_token`), PKCE methods (`plain`, `S256`), DCR support. No doc link. |
| `GET /` | 404 | `404 Not Found` |
| `GET /docs`, `/info`, `/openapi`, `/swagger`, `/health`, `/v1`, `/api`, `/.well-known/mcp`, `/.well-known/openid-configuration` | 404 | — |

CORS is permissive (`access-control-allow-origin: *`) and the host exposes `Mcp-Session-Id` — consistent with the MCP "Streamable HTTP" transport — but nothing in the unauthenticated surface points to documentation.

## Public info sources (recommended reading order)

All public and unauthenticated. Order is what an unfamiliar reader who wants to use the server directly over HTTP should read: orient → integrate → tool catalog. Together they cover the URL, OAuth/transport, and tool inventory; tool input schemas come from a runtime `tools/list` call.

| URL | Authed? | What it covers |
| --- | --- | --- |
| ★1 `https://developers.notion.com/guides/mcp/overview` | No | What Notion MCP is, top-level capabilities, links onward. Outbound links: `/llms.txt`, `modelcontextprotocol.io/introduction`, `/reference/intro`, `/guides/mcp/common-mcp-clients`. |
| ★2 `https://developers.notion.com/guides/mcp/build-mcp-client` | No | Client-build guide. MCP SDK code: `StreamableHTTPClientTransport` against `${serverUrl}/mcp` with `Authorization: Bearer ${accessToken}`. Names the endpoint, shows transport + auth pattern, links to the MCP spec. |
| ★3 `https://developers.notion.com/guides/mcp/mcp-supported-tools` | No | Tool reference. Each tool with name + description + example prompts: `notion-search`, `notion-fetch`, `notion-create-pages`, `notion-update-page`, `notion-move-pages`, `notion-duplicate-page`, `notion-create-database`, `notion-update-database`, `notion-create-comment`, `notion-get-comments`, `notion-get-users`, `notion-get-user`, `notion-get-self`, etc. Does **not** publish full input/output schemas. |

## Caveats / things still not checked

- **Authenticated MCP session probes.** We haven't completed an OAuth round-trip and called `initialize` / `resources/list` / `prompts/list` against the live server. The MCP `initialize` response can carry an optional `instructions` field — Notion may already populate it with usage guidance, in which case we should mention that an agent can read it post-handshake. Worth checking before final wording.
- **Stability of `/guides/mcp/*` URLs.** They show as `/docs/...` in some places and `/guides/mcp/...` in others on developers.notion.com — need to confirm which form is canonical for linking. The `llms.txt` index uses `/guides/mcp/*.md`, which suggests those are the canonical paths.

## Implications for ask #3 (revised)

The earlier draft of this doc concluded "no first-party docs exist." That was wrong — it was based on reading only `/docs/mcp` (the overview), which deliberately doesn't drill into HTTP usage. **The actual situation is good enough to satisfy Hynek's bar.** Notion publishes a per-tool reference, a client-build guide that names the URL/transport/auth, and the MCP spec covers protocol semantics. The `info` string can point at these directly.

## Options for the `info` string

The `info` string itself is an overview of NotionMcp, so linking ★1 (`/guides/mcp/overview`) from inside `info` is redundant. The useful links are ★2 (integration mechanics) and ★3 (tool inventory).

1. **Two links — ★2 + ★3.** Link `https://developers.notion.com/guides/mcp/build-mcp-client` (URL + transport + auth + worked code) and `https://developers.notion.com/guides/mcp/mcp-supported-tools` (tool catalog). Tightest; matches what the agent actually needs to act.
2. **Two links + protocol spec.** Add `https://spec.modelcontextprotocol.io` for agents that want JSON-RPC framing without going through the SDK. Mildly redundant with ★2, which already links to the spec.
3. **One link — ★1 only.** Link only `https://developers.notion.com/guides/mcp/overview` and let the agent follow onward links. Lowest maintenance, an extra hop for the agent.

In all options, also describe in prose what the service is, that it's OAuth-gated, and that exact tool input schemas are discovered via `tools/list` at runtime.

## Tentative lean

Option 1 (★2 + ★3). Two links, each load-bearing, no overlap. Prose around them mentions: hosted MCP server at `https://mcp.notion.com/mcp`, OAuth 2.0 + PKCE + DCR, tool input schemas via runtime `tools/list`. Confirm canonical URL form (`/guides/mcp/...` vs `/docs/...`) before committing.
