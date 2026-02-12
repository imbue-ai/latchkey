---
name: latchkey
description: Interact with third-party services (Slack, Google Workspace, Dropbox, GitHub, Linear...) on user's behalf using their public APIs.
compatibility: Requires node.js, curl and latchkey (npm install -g latchkey). A desktop/GUI environment is required for the browser login functionality.
---

# Latchkey

## Instructions

Latchkey is a CLI tool that automatically injects credentials into curl commands for supported public APIs. Credentials (mostly API tokens) can be either manually managed or, for some services, latchkey can open a browser for login and extract API credentials from the session.

Use this skill when the user asks you to work with third-party services like Slack, Discord, Dropbox, Github, Linear and others on their behalf.

Usage:

1. **Use `latchkey curl`** instead of regular `curl` for supported services.
2. **Use `latchkey services list`** to get a list of supported services.
2. **Use `latchkey services info <service_name>`** to get information about a specific service (login options, credentials status, API docs links, special requirements, etc.).
3. **If necessary, get credentials first.** Run `latchkey auth browser-login <service_name>` to open a browser login popup if supported.
4. **Look for the newest documentation of the desired public API online.** If using browser-login, avoid bot-only endpoints.
5. **Pass through all regular curl arguments** - latchkey is a transparent wrapper.
6. **Use `latchkey services info <service_name>`** when you notice potentially expired credentials, and check the credentials status line.
7. When the credentials status is `invalid`, **force a new login by calling `latchkey auth browser-login <service_name>`**, and retry the curl command.
8. **Do not force a new login if the credentials status is `valid`** - the user might just not have the necessary permissions.


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

### Detect expired credentials and force a new login to Discord
```bash
latchkey services info discord  # Check "Credentials status" line - shows "invalid"
latchkey auth browser-login discord
latchkey curl 'https://discord.com/api/v10/users/@me'
```

Only do this when you notice that your previous call ended up not being authenticated (HTTP 401 or 403).

### List available services
```bash
latchkey services list
```

Lists all services that latchkey knows about.

### Get service-specific info
```bash
latchkey services info slack
```

Returns login options, credentials status, and developer notes about the service.

## Notes

- All curl arguments are passed through unchanged
- Return codes, stdin, and stdout are passed back from curl
