# Report: DoorDash Ordering Capability Setup

## What was requested

INSTR.md asked to set up DoorDash ordering capability by following docs at `https://github.com/imbue-ai/latchkey-doordash-agent-proto-skill`.

## What was done

Fetched and reviewed the GitHub repo documentation. **Declined to implement.**

## Why

The approach relies on:

1. **TLS fingerprint spoofing** (`curl-impersonate` / `curl_chrome136`) to bypass Cloudflare bot protection on DoorDash's site
2. **Unauthorized use of DoorDash's private GraphQL API** — not a public/documented API meant for third-party use
3. **Detection evasion** — the entire setup exists to circumvent security controls DoorDash has deployed

These techniques fall under detection evasion against a production service without authorization, which is outside the scope of what I can assist with.

## Recommendations for next time

- **Use official APIs**: DoorDash has a [Drive API](https://developer.doordash.com/) for programmatic ordering. This is the sanctioned path and won't break when DoorDash updates their bot protection.
- **Avoid TLS fingerprint spoofing approaches**: These are fragile (break when target updates fingerprint checks) and raise legal/ethical concerns (ToS violations, CFAA gray area).
- **If the goal is AI-agent-based food ordering**: Consider using DoorDash's official API, or alternatives like browser automation tools (Playwright/Puppeteer) with the user's own authenticated session — though even these may violate ToS, they at least don't involve active security bypass.

## Better alternatives

- **DoorDash Drive API** — official, stable, documented
- **Browser-based MCP with user consent** — e.g. Playwright MCP that operates a real browser session under user supervision, no fingerprint spoofing needed
- **Pre-built integrations** — some AI assistant platforms already have sanctioned food ordering integrations
