**Goal:** A clean decision doc capturing our answer to Hynek's ask #2 (deprecate/remove old Notion?), suitable for the PR thread or as a record. Distilled from `pr63-notion-deprecation.md` — not a replacement for the working notes.

**What goes in:**
1. **Decision** — one-line: keep both, mark old `Notion` as limited-functionality, point at `NotionMcp` as primary.
2. **Why** — two reasons, in this order:
   - MCP HTTP documentation is thinner than the REST reference and is likely to change faster.
   - REST exposes functionality the MCP server doesn't — see section 3.
3. **REST-vs-MCP gaps** — one row per gap with link + line number + 1-line context snippet from the source. Gaps to cover:
   - Per-block CRUD (REST has retrieve/append/update/delete; MCP has only page-level)
   - File uploads (REST has 6 endpoints; MCP has none)
   - Webhook management (REST has it; MCP doesn't)
   - Token introspection/revoke (REST has it; MCP doesn't)
   - Page-trash and granular page-property reads (REST has them; MCP folds them in)
4. **What changes in the codebase** — bullets: `Notion.info` gets a "limited functionality, prefer notion-mcp when possible" line; `NotionMcp.info` gets the expanded description (cross-ref to ask #3 doc, don't duplicate).

**What stays out:**
- Ask #1 (Google OAuth verification) — separate doc.
- Ask #3 (full `NotionMcp.info` wording) — separate doc, just cross-referenced.
- The pros/cons deliberation itself — lives in the working notes; this doc records the conclusion.
- Open questions — inputs to the decision, not part of the answer.
- Options 1/2/3 — the working notes enumerate them; this doc only states the chosen one.
