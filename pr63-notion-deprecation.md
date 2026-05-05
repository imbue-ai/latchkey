bowei's decision:

yeah so it sounds like we should keep notion api but mark it as limited-functionality in info.

reasons
1. worse mcp documentation, and it's likely to change faster
2. rest API has some better functionality as seen here: (needs verification with evidence and links to the rest API snippets)

**Gaps in the MCP surface vs REST:**
a **No per-block CRUD.** REST has retrieve/append/update/delete on individual blocks; MCP only has `notion-update-page` (page-level) and `notion-fetch`. Agents that build pages incrementally block-by-block lose granularity.
b **No file uploads.** REST has 6 file-upload endpoints (including external-URL import); MCP has none. Anything that uploads images/attachments needs the REST API.
c **No webhook management.** REST exposes webhook endpoints; MCP does not.
d **No token introspection/revoke.** Pure auth-management endpoints aren't surfaced as MCP tools (this matters less for agents, but is a real gap).
e **No page-trash, no granular page-property reads.** REST has `Trash a page` and `Retrieve a page property item`; MCP rolls these into broader update/fetch tools.

--

# Should we deprecate/remove the old Notion integration?

Working doc for ask #2 from `pr63-asks-summary.md`.

## Context

- `src/services/notion.ts` (old `Notion`): Playwright-driven UI scraping at `notion.so/profile/integrations/...` to create an "internal integration" and extract a bearer token. Talks to `api.notion.com` (public Notion REST API).
- `src/services/notion-mcp.ts` (new `NotionMcp`): OAuth 2.0 + PKCE + dynamic client registration against `mcp.notion.com`. Talks to the Notion MCP server endpoint at `mcp.notion.com/mcp`.

These hit different API surfaces, not just different auth flows.

## Pros of removing the old integration

- **Brittle UI automation.** notion.ts relies on `getByRole` / `nth(...)` locators because Notion's DOM has no IDs. Breaks whenever Notion ships a UI change — see recent commits `7470f9c` and the in-file comment "Notion's DOM is devoid of IDs".
- **English-locale-only.** Documented limitation in the file header — the old flow silently fails for non-English users.
- **Limited access scope.** Only grants access to pages that existed at first login; new pages require a manual re-grant.
- **No refresh-token support.** Old flow uses a long-lived integration token; new flow has proper OAuth refresh via `refreshCredentials`.
- **Less code to maintain.** ~127 lines of Playwright selectors disappear.
- **Standards-based.** MCP flow uses OAuth 2.0 / PKCE / dynamic registration — far more robust than DOM scraping.

## Cons of removing the old integration

- **API surface is narrower** (confirmed — see Evidence section). MCP exposes 18 tools; REST exposes 60+ endpoints. Notable missing functionality in MCP: per-block CRUD, file uploads, webhooks, token introspection.
- **Documentation gap, confirmed (Hynek's concern).** The public REST API has `developers.notion.com/reference` with full request/response schemas. The MCP-supported-tools page documents tool semantics for MCP-client use only — there's no HTTP-call reference for an agent calling `mcp.notion.com` directly.
- **Beta status.** `NotionMcp.info` currently says "Notion MCP (Beta)" — risk of breaking changes from Notion's side.
- **Migration cost for existing users.** Anyone with credentials saved under `notion` would need to re-auth as `notion-mcp`.
- **OAuth flow needs a working callback server.** Requires a usable localhost port; old flow doesn't.

## Evidence: REST API vs MCP surface

Sources: `developers.notion.com/llms.txt` (REST endpoint index) and `developers.notion.com/guides/mcp/mcp-supported-tools` (MCP tool list).

**REST API** (`api.notion.com`, ~60+ endpoints across these categories):
- Pages: create, retrieve, update, trash, move, retrieve page property item
- Databases: create, retrieve, update, query, update property schema
- Data sources: create, retrieve, update, query, filter
- Blocks: retrieve, append children, update, delete (per-block CRUD)
- File uploads: create, send, complete, retrieve, list, import from external URL
- Comments: create, list, attachments, display names
- Views: create, retrieve, update, delete, query, paginate results
- Users: list, retrieve, retrieve bot, retrieve me
- Auth/tokens: create, refresh, revoke, introspect
- Search by title
- Webhooks: management endpoints

**MCP server** (`mcp.notion.com`, 18 tools per official docs):
- Search/query: `notion-search`, `notion-query-data-sources`, `notion-query-database-view`
- Fetch: `notion-fetch` (page/db/data-source by URL or ID)
- Pages: `notion-create-pages`, `notion-update-page`, `notion-move-pages`, `notion-duplicate-page`
- Databases/views: `notion-create-database`, `notion-update-data-source`, `notion-create-view`, `notion-update-view`
- Comments: `notion-create-comment`, `notion-get-comments`
- Workspace: `notion-get-teams`, `notion-get-users`, `notion-get-user`, `notion-get-self`

**Gaps in the MCP surface vs REST:**
- **No per-block CRUD.** REST has retrieve/append/update/delete on individual blocks; MCP only has `notion-update-page` (page-level) and `notion-fetch`. Agents that build pages incrementally block-by-block lose granularity.
- **No file uploads.** REST has 6 file-upload endpoints (including external-URL import); MCP has none. Anything that uploads images/attachments needs the REST API.
- **No webhook management.** REST exposes webhook endpoints; MCP does not.
- **No token introspection/revoke.** Pure auth-management endpoints aren't surfaced as MCP tools (this matters less for agents, but is a real gap).
- **No page-trash, no granular page-property reads.** REST has `Trash a page` and `Retrieve a page property item`; MCP rolls these into broader update/fetch tools.

**Documentation gap (Hynek's concern, confirmed):**
- The MCP "Supported tools" page documents tools through MCP clients only — there is no HTTP-call reference (no per-tool request/response schema for direct HTTP/JSON-RPC). Notion's blog and search results indicate the transport is `https://mcp.notion.com/sse` (SSE-based MCP), not a documented REST surface.
- An agent that knows how to call `api.notion.com` from `developers.notion.com/reference` does **not** automatically know how to call `mcp.notion.com` over HTTP. It would need an MCP client, or it would need to reverse-engineer the JSON-RPC envelope.
- This validates the concern in `notion-mcp.ts`'s `info` string being thin — there's no good public doc to link to for raw-HTTP use.

## Open questions

- Are there any users of the old `notion` integration today who would be broken by removal?
- If we keep both, how do we steer agents to the right one via the `info` strings? (This is ask #3.)
- Does latchkey actually expose tools to agents in a way that benefits from MCP framing, or do agents end up calling these endpoints over plain HTTP? If the latter, the MCP server's lack of HTTP documentation is a hard blocker for full migration.

## Options

1. **Remove old integration now.** Cleanest, but risks functional regressions if MCP surface is narrower.
2. **Keep both, mark old as deprecated.** Update `Notion.info` to recommend `notion-mcp` and explain when to fall back. Lowest risk, highest maintenance.
3. **Keep both, no deprecation signal.** Status quo of this PR. Agents pick blindly based on `info`.

## Tentative lean

(fill in)
