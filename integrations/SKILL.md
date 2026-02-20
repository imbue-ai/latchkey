---
name: latchkey
description: Interact with third-party services (Slack, Google Workspace, Dropbox, GitHub, Linear...) on the user's behalf using their public APIs.
compatibility: Requires node.js, curl and latchkey (npm install -g latchkey). A desktop/GUI environment is required for the browser functionality.
---

# Latchkey

## Instructions

Latchkey is a CLI tool that automatically injects credentials into curl commands for supported public APIs. Credentials (mostly API tokens) can be either manually managed or, for some services, Latchkey can open a browser login pop-up window and extract API credentials from the session.

Use this skill when the user asks you to work with third-party services like Slack, Discord, Dropbox, GitHub, Linear and others on their behalf.

Usage:

1. **Use `latchkey curl`** instead of regular `curl` for supported services.
2. **Pass through all regular curl arguments** - latchkey is a transparent wrapper.
3. **Use `latchkey services list`** to get a list of supported services.
4. **Use `latchkey services info <service_name>`** to get information about a specific service (auth options, credentials status, API docs links, special requirements, etc.).
5. **If necessary, get or renew credentials first.** Run `latchkey auth browser <service_name>` to open a browser login pop-up window if supported.
6. **Look for the newest documentation of the desired public API online.** If using the `browser` auth command, avoid bot-only endpoints.
7. **Do not initiate a new login if the credentials status is `valid`** - the user might just not have the necessary permissions for the action you're trying to do.


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
latchkey services info discord  # Check the "credentialStatus" field - shows "invalid"
latchkey auth browser discord
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

Returns auth options, credentials status, and developer notes
about the service. If `browser` is not present in the
`authOptions` field, the service requires the user to directly
set API credentials via `latchkey auth set` or `latchkey auth
set-nocurl` before making requests.

## Notes

- All curl arguments are passed through unchanged
- Return code, stdout and stderr are passed back from curl

## Currently supported services

Latchkey currently offers varying levels of support for the
following services: AWS, Calendly, Discord, Dropbox, Figma, GitHub, GitLab,
Gmail, Google Analytics, Google Calendar, Google Docs, Google Drive, Google Sheets,
Linear, Mailchimp, Notion, Sentry, Slack, Stripe, Telegram, Yelp, Zoom, and more.
