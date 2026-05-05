# Draft GitHub reply to Hynek on PR #63

Short version. Sources: `pr63-decision-keep-old-notion.md`, `pr63-info-string.md`. OAuth attested manually by @boweiliu on 2026-05-05.

---

@hynek-urban Thanks!

1. **Google OAuth** — manually re-tested by a human, still works.
2. **Keep the old Notion integration?** Yes — the REST API exposes things `mcp.notion.com` doesn't: per-block CRUD, file uploads, webhook management, token introspect/revoke, page-trash, granular page-property reads. `Notion.info` now marks it as limited-functionality and points at `notion-mcp` as the default; we can revisit removing it once MCP closes those gaps. Full write-up with the gap evidence: [`pr63-decision-keep-old-notion.md`](https://github.com/imbue-ai/latchkey/blob/wip/pr63-docs/pr63-decision-keep-old-notion.md).
3. **`NotionMcp.info`** — expanded on this branch. I also tested with an agent to "set up notion" and it correctly defaulted to the mcp version.
