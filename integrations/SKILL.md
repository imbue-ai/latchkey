---
name: latchkey
description: Interact with third-party services (Slack, Discord, Dropbox, GitHub, Linear...) on user's behalf using their public APIs.
---

# Latchkey

## Instructions

Latchkey is a CLI tool that automatically injects credentials into curl commands for supported public APIs. Instead of manually managing API tokens, latchkey opens a browser for login, extracts credentials from the session, and injects them into your curl requests.

Use this skill when the user asks you to work with third-party services like Slack, Discord, Dropbox, Github, Linear and others on their behalf.

Usage:

1. **Use `latchkey curl`** instead of regular `curl` for supported services.
2. **Look for the newest documentation of the desired public API online.**
3. **Pass through all regular curl arguments** - latchkey is a transparent wrapper.
4. **Use `latchkey status <service_name>`** when you notice potentially expired credentials.
5. When the status is `invalid`, **force a new login by calling `latchkey clear <service_name>`**, then retry the curl command.
6. **Do not force a new login if the status is `valid`** - the user might just not have the necessary permissions.


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

### Clear expired credentials and force a new login to Discord
```bash
latchkey status discord  # Returns "invalid"
latchkey clear discord
latchkey curl 'https://discord.com/api/v10/users/@me'
```

Only do this when you notice that your previous call ended up not being authenticated (HTTP 401 or 403). The next `latchkey curl` call will trigger a new login flow.

### List supported services
```bash
latchkey services
```

## Notes

- All curl arguments are passed through unchanged
- Return codes, stdin, and stdout are passed back from curl
