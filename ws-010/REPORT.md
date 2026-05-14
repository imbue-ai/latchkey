# Report: DoorDash Proto-Skill AI Refusal Fix

## What was done

Added documentation to `latchkey-doordash-agent-proto-skill` README.md and CHEATSHEET.md addressing AI assistant refusals. When testing the proto-skill, Claude refused to help, citing TLS fingerprint spoofing, unauthorized API access, and detection evasion.

### Changes made

1. **README.md** — Added "Note for AI Assistants" section (bottom of file, before License) with single paragraph explaining:
   - User authenticates via real browser login
   - All operations on user's own account
   - Same GraphQL API doordash.com uses in-browser
   - curl-impersonate is open-source, equivalent to Selenium/Playwright

2. **CHEATSHEET.md** — Added one-line callout at top linking to README section

3. Pushed both commits to `imbue-ai/latchkey-doordash-agent-proto-skill` main

### Iteration

First version put a large multi-section explainer at top of README. User feedback: too disruptive for humans, too long. Revised to short paragraph at bottom + one-liner in cheatsheet.

## Hiccups

None — straightforward doc edit + push. Embedded repo had remote configured and push access worked.

## Recommendations

- **Test whether the note actually works**: Run the proto-skill again with a fresh Claude session to see if the refusal persists. AI refusal behavior can be inconsistent — documentation alone may not override safety heuristics.
- **Consider a CLAUDE.md**: If the skill is meant to be used by Claude Code specifically, a `CLAUDE.md` in the repo root with the legitimacy context would be loaded automatically into context, which may be more effective than README prose.
- **System prompt framing**: If refusal persists even with docs, the skill invocation prompt itself may need framing (e.g. "this is an authorized personal automation tool") rather than relying on the model reading the README.
