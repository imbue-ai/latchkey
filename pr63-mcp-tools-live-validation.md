# Live validation of Notion MCP tools list and gaps

Companion to `pr63-decision-keep-old-notion.md`. Validates that doc's gap claims against the **live** `tools/list` response from `https://mcp.notion.com/mcp`, plus exercise of a few endpoints to see actual payload shapes.

Method: `latchkey curl` against `https://mcp.notion.com/mcp` with the existing `notion-mcp` credentials. JSON-RPC over Streamable HTTP. `initialize` → `notifications/initialized` → `tools/list` → spot-`tools/call`. Server self-identified as `"Notion MCP" v1.2.0`, protocol `2024-11-05`. All raw transcripts live in `/tmp/tools-list.txt`, `/tmp/tools-schemas.txt`, `/tmp/{search,fetch,...}-result.txt`.

## TL;DR

- All five **gap categories** in the decision doc (per-block CRUD, file uploads, webhooks, token introspection/revoke, page-trash + granular property reads) are **confirmed** by live `tools/list`. No tool covers any of them; calls to plausibly-named tools all return `MCP error -32602: Tool ... not found`.
- The decision doc's **tool catalog is stale**, however. It claims 18 tools and enumerates three (`notion-query-data-sources`, `notion-get-user`, `notion-get-self`) that the live server does not expose. The live server returns **16** tools, and includes one not listed in the doc (`notion-query-meeting-notes`). Self/user lookup is folded into `notion-get-users` via a `user_id` parameter (with `"self"` as a sentinel).
- The decision doc's other rationale — that **MCP HTTP documentation is thinner than the REST reference and is likely to change faster** — is reinforced by this drift between the published guide and what the server actually exposes.

## Live tool list (16)

```
notion-search                  notion-update-data-source
notion-fetch                   notion-create-comment
notion-create-pages            notion-get-comments
notion-update-page             notion-get-teams
notion-move-pages              notion-get-users
notion-duplicate-page          notion-query-database-view
notion-create-database         notion-query-meeting-notes
notion-create-view             notion-update-view
```

### Catalog drift vs the decision doc

| In doc, not live | In live, not in doc | Explanation |
| --- | --- | --- |
| `notion-query-data-sources` | — | Returns "Tool not found". Live equivalent appears to be `notion-query-database-view` (queries via a saved view URL) or filter via `notion-query-meeting-notes` for that specific data source. There is no general "query an arbitrary data source by filter/sort" tool exposed. |
| `notion-get-user` | — | Folded into `notion-get-users` — `user_id` parameter fetches a single user. |
| `notion-get-self` | — | Folded into `notion-get-users` — pass `user_id: "self"`. Verified: returns `{"results":[{"type":"person","id":"9a9ed1ba-…","name":"Bowei Liu","email":"bowei@imbue.com"}],"has_more":false}`. |
| — | `notion-query-meeting-notes` | Not in the doc's enumeration. Filters the current user's meeting-notes data source. |

Action item for the decision doc: drop the parenthetical "18 tools, enumerated below for completeness" — either omit the count or fetch it at runtime, because the published guide and the live server disagree today.

## Gap-by-gap validation

### 1. Per-block CRUD — confirmed gap

Direct calls to plausibly-named block tools all 404:

```
notion-update-block  → MCP error -32602: Tool notion-update-block not found
notion-append-block  → MCP error -32602: Tool notion-append-block not found
```

The closest live tools and their shapes:

- **`notion-update-page`** — required params: `page_id`, `command` (one of `update_properties | update_content | replace_content | apply_template | update_verification`), and either `properties` or `content_updates`. The `content_updates` array uses `{old_str, new_str, replace_all_matches?}` — i.e. **whole-page string search-and-replace**, not block-id targeting. There is no `block_id` field anywhere in the schema. `replace_content` takes a single `new_str` that overwrites the entire page body.
- **`notion-create-pages`** — `pages[].content` is a single Markdown string. No way to specify individual blocks with stable IDs.
- **`notion-fetch`** — returns "enhanced Markdown" (e.g. `<page url="…"><content>…<details><summary>…</summary></details>…</content></page>`). The XML-ish tags (`<mention-page>`, `<details>`, `<empty-block/>`, `<unknown alt="button"/>`) carry context but **no block UUIDs** that you could feed back into an update tool. Block identity is not part of the round-trip.

So agents that need stable block-level handles (e.g. "delete this one toggle, append a child to that block") cannot do it through MCP. REST `retrieve-a-block`, `patch-block-children`, `update-a-block`, `delete-a-block`, `get-block-children` remain the only way.

### 2. File uploads — confirmed gap

```
notion-create-file   → Tool not found
notion-upload-file   → Tool not found
```

No tool name in the live list matches `*file*`. `notion-create-pages` accepts `cover` and `icon` only as **external image URLs** (or emoji); no inline-upload path. REST's three-step file upload (`create-file` → `upload-file` → `complete-file-upload`) plus `retrieve-file-upload` and `list-file-uploads` are unreachable via MCP.

### 3. Webhook management — confirmed gap

```
notion-create-webhook → Tool not found
```

No tool matches `*webhook*`. The MCP server doesn't surface webhook subscription management at all.

### 4. Token introspection / revoke — confirmed gap

```
notion-introspect-token → Tool not found
```

No `*token*` tool in the live list. (Aside: this is somewhat expected because MCP itself models auth at the transport layer rather than as RPC tools — but the gap is real if you want programmatic token lifecycle.)

### 5. Page-trash and granular page-property reads — confirmed, with one nuance

```
notion-trash-page         → Tool not found
notion-get-page-property  → Tool not found
```

- **Page-trash**: there is no dedicated tool. The closest is `notion-update-data-source`, whose schema has an `in_trash: boolean` field — but that operates on **data sources** (collections), not on individual pages. Trashing an arbitrary page via MCP would require something like a `notion-update-page` "command" that supports it, which is not in the current enum.
- **Granular page-property reads**: `notion-fetch` returns the page's full property block embedded in the response (`<properties>{…}</properties>`); there is no per-property endpoint. For pages with very large rollups/relations this is the same "read the whole page" cost the REST `retrieve-a-page-property` is meant to avoid.

## Endpoint-shape notes (for anyone wiring an agent through MCP)

Not strictly required to validate the decision, but worth recording while the session is open:

- **JSON-RPC envelope**: results from `tools/call` are wrapped twice. The outer JSON-RPC `result.content[0].text` is itself a JSON string (or, for `notion-fetch`, a JSON document whose `text` field is the enhanced-Markdown payload). Consumers must double-parse.
- **Errors are not JSON-RPC errors**: a 404 from the upstream Notion REST surfaces as `result.content[0].text = "{\"name\":\"APIResponseError\",\"code\":\"object_not_found\",\"status\":404,…}"` with `isError: true` on the result, not as a top-level `error`. Tool-not-found, by contrast, is also returned with `isError: true` and a `-32602` code embedded in the text string. Robust clients have to inspect both.
- **SSE framing**: the server returns `event: message\ndata: {…}\n\n` even for single-shot replies; clients need to strip the `data: ` prefix.
- **Session header**: `mcp-session-id` from the `initialize` response must be sent on all subsequent calls; without it the server treats each call as a fresh init.
- **`notion-search` results carry IDs not URLs**: despite the field name, the `url` field returned is a bare UUID (e.g. `d03a550f-af95-8214-b0ed-81b14a91eaac`). Both forms work as input to `notion-fetch`.
- **`notion-get-comments` on a clean page** returns `"{}"` (string) inside the content, not `{"comments": []}` — another shape clients must special-case.

## Conclusion

The decision doc's load-bearing claim — "REST exposes functionality the MCP server doesn't" — holds in every category it lists. The supporting tool enumeration in the doc's "Sources" paragraph is mildly stale and should either be regenerated from `tools/list` or rephrased to not pin a specific count and roster.
