# Latchkey

Inject API credentials into local agent requests.

## Quick example

```
# User stores the credentials.
latchkey auth set slack -H "Authorization: Bearer xoxb-your-token"

# Agent makes http calls.
latchkey curl -X POST 'https://slack.com/api/conversations.create' \
  -H 'Content-Type: application/json' \
  -d '{"name":"something-urgent"}'
```

## Overview

Latchkey is a command-line tool that injects credentials into curl
requests to known public APIs.

- `latchkey services list`
	- List supported third-party services (Slack, Google Workspace, Linear, GitHub, etc.).
- `latchkey curl <arguments>`
	- Automatically inject credentials to your otherwise standard curl calls to public APIs.
	- Credentials must already exist (see below).
- `latchkey auth set <service_name> <curl_arguments>`
	- Manually store credentials for a service as arbitrary curl arguments.
- `latchkey auth browser <service_name>`
	- Open a browser login pop-up window and store the resulting API credentials.
    - This also allows agents to prompt users for credentials.
    - Only some services support this option.

Latchkey is primarily designed for AI agents. By invoking
Latchkey, agents can prompt the user to authenticate when needed,
then continue interacting with third-party APIs using standard
curl syntax - no custom integrations or embedded credentials
required.

Unlike OAuth-based flows or typical MCP-style integrations,
Latchkey does not introduce an intermediary between the agent
and the service. When `browser` is used, requests are made
directly on the user’s behalf, which enables greater flexibility
at the cost of formal delegation: agents authenticate as the
user.

If a service you need isn’t supported yet, contributions are welcome!
See the [development docs](docs/development.md) for details.

## Installation

### Prerequisites

- `curl`, `node` and `npm` need to be present on your system in reasonably recent versions.
- The `latchkey auth browser` subcommand requires a graphical environment.

### Steps

```
npm install -g latchkey

# Optionally, if you intend to use `latchkey auth browser`:
latchkey ensure-browser
```

The `ensure-browser` command discovers and configures a browser
for Latchkey to use. It searches for Chrome, Chromium, or Edge
on your system. If none is found, it downloads Chromium via
Playwright.

## Integrations

Warning: giving AI agents access to your API credentials is
potentially dangerous, especially when using the `auth browser`
feature. They will be able to perform most of the actions you
can. Only do this if you're willing to accept the risks.


### OpenCode
```
mkdir -p ~/.opencode/skills/latchkey
latchkey skill-md > ~/.opencode/skills/latchkey/SKILL.md
```

### Claude Code
```
mkdir -p ~/.claude/skills/latchkey
latchkey skill-md > ~/.claude/skills/latchkey/SKILL.md
```

### Codex
```
mkdir -p ~/.codex/skills/latchkey
latchkey skill-md > ~/.codex/skills/latchkey/SKILL.md
```

### Passepartout

Check out our [Passepartout demo app](https://github.com/imbue-ai/passepartout)
for an idea of how to build AI assistants for non-technical
users on top of Latchkey.


## Demo

![Image](https://github.com/user-attachments/assets/784bd7eb-6d34-4cab-97d3-4a0f8c4ca9aa)


## Direct usage

Let's revisit the initial example:

```
latchkey curl -X POST 'https://slack.com/api/conversations.create' \
  -H 'Content-Type: application/json' \
  -d '{"name":"something-urgent"}'
```

Notice that `-H 'Authorization: Bearer ...'` is absent. This is
because Latchkey injects stored credentials automatically. To
set up credentials for a service (Slack in this example), run:

```
latchkey auth browser slack
```

This opens the browser with a login screen. After you log in, Latchkey extracts
the necessary API credentials from the browser session, closes the browser, and
stores the credentials so that they can be reused.

Alternatively, you can provide credentials manually:

```
latchkey auth set slack -H "Authorization: Bearer xoxb-your-token"
```

`latchkey curl` passes your arguments straight through to `curl`
so you can use the same interface you are used to. The return
code, stdout and stderr are passed back from curl to the caller
of `latchkey`.

### Indirect credentials

Some services can't express their credentials as static curl
arguments. For example:

- AWS requires a signature that changes with each request.
- Telegram expects bot tokens to be directly part of the URL.

In similar cases, when supported, you can use the `latchkey auth set-nocurl` command, e.g.
like this:

```
latchkey auth set-nocurl telegram <bot-token>
```

Latchkey will then modify subsequent `latchkey curl` requests as
needed. You can find more information (including the expected
signature) by calling `latchkey services info <service_name>`.

### Remembering API credentials

Your API credentials and browser state are encrypted and stored
by default under `~/.latchkey`.


### Inspecting the status of stored credentials

Calling `latchkey services info <service_name>` will show information
about the service, including the credentials status. The
credentials status line will show one of:

- `missing`
- `invalid`
- `valid`

### Clearing credentials

Remembered API credentials can expire. The caller of `latchkey
curl` will typically notice this because the calls will start returning
HTTP 401 or 403. To verify that, first call `latchkey services info`, e.g.:

```
latchkey services info discord
```

If the credentials status is `invalid`, it means the Unauthorized/Forbidden
responses are caused by invalid or expired credentials rather than insufficient
permissions. In that case, log in again:

```
latchkey auth browser discord
```

Or alternatively:

```
latchkey auth set discord -H "Authorization: ..."
```


### Clearing credentials and logins

In case you want to remove stored API credentials, use the `auth clear` subcommand.

```
latchkey auth clear discord
```

To clear all stored data (both the credential store and browser state file), run:

```
latchkey auth clear
```


### Advanced configuration

You can set these environment variables to override certain
defaults:

- `LATCHKEY_DIRECTORY`: path to the directory where Latchkey stores its data (defaults to `~/.latchkey`)
- `LATCHKEY_CURL`: path to the curl binary
- `LATCHKEY_KEYRING_SERVICE_NAME`, `LATCHKEY_KEYRING_ACCOUNT_NAME`: identifiers that are used to store the encryption password in your keyring
- `LATCHKEY_ENCRYPTION_KEY`: override the encryption key, e.g. when a keyring is not available. Example: `export LATCHKEY_ENCRYPTION_KEY="$(openssl rand -base64 32)"`
- `LATCHKEY_DISABLE_BROWSER`: when set (to any non-empty value), disables the browser login flow; commands that would trigger a browser login (`auth browser`, `auth browser-prepare`) will fail with an error instead


## Disclaimers

- This is still a work in progress.
- Latchkey has been created with the help of AI-assisted coding tools with careful human curation.
- Invoking `latchkey auth browser ...` can sometimes have side effects in the form of
  new API keys being created in your accounts (through browser automation).
- Using agents for automated access may be prohibited by some services' ToS.
- We reserve the right to change the license of future releases of Latchkey.
- Latchkey was not tested on Windows.

## Currently supported services

Latchkey currently offers varying levels of support for the
following services: AWS, Calendly, Discord, Dropbox, Figma, GitHub, GitLab,
Gmail, Google Analytics, Google Calendar, Google Docs, Google Drive, Google Sheets,
Linear, Mailchimp, Notion, Sentry, Slack, Stripe, Telegram, Yelp, Zoom, and more.
