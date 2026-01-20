---
name: latchkey
description: Interact with third-party services (Slack, Discord, ...) on user's behalf using their public APIs.
---

# Latchkey

## Instructions

Latchkey is a CLI tool that automatically injects credentials into curl commands for supported public APIs. Instead of manually managing API tokens, latchkey opens a browser for login, extracts credentials from the session, and injects them into your curl requests.

Use this skill when the user asks you to work with third-party services like Slack, Discord and others on their behalf.

Usage:

1. **Use `latchkey curl`** instead of regular `curl` for supported services
2. **Pass through all regular curl arguments** - latchkey is a transparent wrapper
3. **Use the `--latchkey-force-login` flag** when you notice expired credentials


## Examples

### Make an authenticated curl request
```bash
latchkey curl [curl arguments]
```

### Creating a Slack channel
```bash
latchkey curl -X POST 'https://slack.com/api/conversations.create' \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-channel"}'
```

(Notice that `-H 'Authorization: Bearer` is not present in the invocation.)

### Getting Discord user info
```bash
latchkey curl 'https://discord.com/api/v10/users/@me'
```

### Force a new login to Discord
```bash
latchkey curl --latchkey-force-login 'https://discord.com/api/v10/users/@me'
```

Only do this when you notice that your previous call ended up not being authenticated. Omit the flag in subsequent calls again.

### List supported services
```bash
latchkey services
```

### Check if a URL is supported
```bash
latchkey match [curl arguments]
```

(Useful for debugging.)

## Notes

- All curl arguments are passed through unchanged
- Return codes, stdin, and stdout are passed back from curl
