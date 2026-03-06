---
name: latchkey
description: Interact with arbitrary third-party or self-hosted services (Slack, Google Workspace, Dropbox, GitHub, Linear, Coolify...) using their HTTP APIs.
compatibility: Requires node.js, curl and latchkey (npm install -g latchkey).
metadata: {"openclaw":{"emoji":"🔑","requires":{"bins":["latchkey"]},"install":[{"id":"npm","kind":"npm","package":"latchkey","global":true,"bins":["latchkey"],"label":"Install Latchkey (npm)"}]}}
---

# Latchkey

## Instructions

Latchkey is a CLI tool that automatically injects credentials into curl commands. Credentials (mostly API tokens) need to be manually managed by the user.

Use this skill when the user asks you to work with services that have HTTP APIs, like AWS, Coolify, GitLab, Google Drive, Discord or others.

Usage:

1. **Use `latchkey curl`** instead of regular `curl` for supported services.
2. **Pass through all regular curl arguments** - latchkey is a transparent wrapper.
3. **Check for `latchkey services list`** to get a list of supported services. Use `--viable` to only show the currently configured ones.
4. **Use `latchkey services info <service_name>`** to get information about a specific service (auth options, credentials status, API docs links, special requirements, etc.).
5. **If necessary, ask the user to configure credentials first.** Tell the user to run `latchkey auth set` on the machine where latchkey is installed (using the setCredentialsExample from the `services info` command).
6. **Look for the newest documentation of the desired public API online.**
7. **Do not initiate a new login if the credentials status is `valid` or `unknown`** - the user might just not have the necessary permissions for the action you're trying to do.


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

### Detect expired credentials
```bash
latchkey services info discord  # Check the "credentialStatus" field - shows "invalid"
```

### List usable services

```bash
latchkey services list --viable
```

Lists services that have stored credentials.

### Get service-specific info
```bash
latchkey services info slack
```

Returns auth options, credentials status, and developer notes
about the service.


## Storing credentials

It is the user's responsibility to supply credentials. The user would typically do something like this:

```bash
latchkey auth set my-gitlab-instance -H "PRIVATE-TOKEN: <token>"
```

When credentials cannot be expressed as static curl arguments, the user would use the `set-nocurl` subcommand. For example:

```bash
latchkey auth set-nocurl aws <access-key-id> <secret-access-key>
```

If a service doesn't appear with the `--viable` flag, it may
still be supported; the user just hasn't provided the
credentials yet. `latchkey service info <service_name>` can be
used to see how to provide credentials for a specific service.


## Notes

- All curl arguments are passed through unchanged
- Return code, stdout and stderr are passed back from curl
- Credentials are always stored encrypted and are never transmitted anywhere beyond the endpoints specified by the actual curl calls.

## Currently supported services

Latchkey currently offers varying levels of support for the
following services: AWS, Calendly, Coolify, Discord, Dropbox, Figma, GitHub, GitLab,
Gmail, Google Analytics, Google Calendar, Google Docs, Google Drive, Google Sheets,
Linear, Mailchimp, Notion, Sentry, Slack, Stripe, Telegram, Umami, Yelp, Zoom, and more.

### User-registered services

Note for humans: users can also add limited support for new services
at runtime using the `latchkey services register` command.
