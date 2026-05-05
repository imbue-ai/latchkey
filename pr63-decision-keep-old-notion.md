## Decision

Keep both `Notion` and `NotionMcp`. Update `Notion.info` to mark the old integration as limited-functionality and steer agents to `NotionMcp` as the default; the old REST integration stays as a fallback for the gaps documented below.

## Why

1. **MCP HTTP documentation is thinner than the REST reference and is likely to change faster.** The REST API publishes full per-endpoint request/response schemas under `developers.notion.com/reference/*`; the corresponding MCP endpoints are less well-documented and are likely to change.
2. **REST exposes functionality the MCP server doesn't** — see the gap table below.

## REST-vs-MCP gaps

Sources:

- REST: `https://developers.notion.com/llms.txt` — canonical line-numbered index of every doc page on the site, including every `reference/*` endpoint.
- MCP: `https://developers.notion.com/guides/mcp/mcp-supported-tools` — the full tool list (18 tools, enumerated below for completeness): `notion-search`, `notion-fetch`, `notion-create-pages`, `notion-update-page`, `notion-move-pages`, `notion-duplicate-page`, `notion-create-database`, `notion-update-data-source`, `notion-create-view`, `notion-update-view`, `notion-query-data-sources`, `notion-query-database-view`, `notion-create-comment`, `notion-get-comments`, `notion-get-teams`, `notion-get-users`, `notion-get-user`, `notion-get-self`.

| Gap | REST evidence (link + `llms.txt` line + 1-line snippet) | MCP status |
| --- | --- | --- |
| Per-block CRUD | `llms.txt:101` [retrieve-a-block](https://developers.notion.com/reference/retrieve-a-block.md) — "Retrieves a Block object using the ID specified." · `llms.txt:89` [patch-block-children](https://developers.notion.com/reference/patch-block-children.md) — "Creates and appends new children blocks to the parent `block_id` specified." · `llms.txt:118` [update-a-block](https://developers.notion.com/reference/update-a-block.md) · `llms.txt:64` [delete-a-block](https://developers.notion.com/reference/delete-a-block.md) · `llms.txt:72` [get-block-children](https://developers.notion.com/reference/get-block-children.md) — "Returns a paginated array of child block objects contained in the block." | None. Closest are `notion-update-page` (page-level only) and `notion-fetch` (read-only). Agents that build pages incrementally block-by-block lose granularity. |
| File uploads | `llms.txt:59` [create-file](https://developers.notion.com/reference/create-file.md) — "Use this API to initiate the process of uploading a file to your Notion workspace." · `llms.txt:127` [upload-file](https://developers.notion.com/reference/upload-file.md) — "Use this API to transmit file contents to Notion for a file upload." · `llms.txt:53` [complete-file-upload](https://developers.notion.com/reference/complete-file-upload.md) — "Use this API to finalize a `mode=multi_part` file upload after all of the parts have been sent successfully." · `llms.txt:109` [retrieve-file-upload](https://developers.notion.com/reference/retrieve-file-upload.md) · `llms.txt:83` [list-file-uploads](https://developers.notion.com/reference/list-file-uploads.md) · `llms.txt:11` [importing-external-files](https://developers.notion.com/guides/data-apis/importing-external-files.md) — "Learn how to migrate files from an external URL to Notion." | None. Anything that uploads images/attachments needs the REST API. |
| Webhook management | `llms.txt:131` [webhooks](https://developers.notion.com/reference/webhooks.md) — "Learn how your connection can automatically respond to workspace activity in real-time." · `llms.txt:132` [webhooks-events-delivery](https://developers.notion.com/reference/webhooks-events-delivery.md) — "Learn about the different event types and how they are delivered to your connection." (plus 30+ per-event references at `llms.txt:133–163`). | None. |
| Token introspection / revoke | `llms.txt:79` [introspect-token](https://developers.notion.com/reference/introspect-token.md) — "Get a token's active status, scope, and issued time." · `llms.txt:111` [revoke-token](https://developers.notion.com/reference/revoke-token.md) — "Revoke an access token." | None. Less load-bearing for agent workflows but still a real gap. |
| Page-trash and granular page-property reads | `llms.txt:116` [trash-page](https://developers.notion.com/reference/trash-page.md) — "Trash a page." · `llms.txt:105` [retrieve-a-page-property](https://developers.notion.com/reference/retrieve-a-page-property.md) — "Retrieve a page property item." | No dedicated page-trash tool. No retrieve-page-property-item tool — both subsumed into the broader `notion-fetch` / `notion-update-page` shape. |

