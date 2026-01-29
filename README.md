# Latchkey

Turn browser logins into usable credentials for local agents.

## Quick example

```
latchkey curl -X POST 'https://slack.com/api/conversations.create' \
  -H 'Content-Type: application/json' \
  -d '{"name":"something-urgent"}'
```

## Overview

Latchkey is a command-line tool that injects credentials to curl requests to known public APIs.

- `latchkey services`
	- Get a list of known and supported third-party services (Slack, Discord, Linear, GitHub, ...).
- `latchkey curl <arguments>`
	- Automatically inject credentials to your otherwise standard curl calls to public APIs.
	- (The first time you access a service, a browser pop-up with a login screen appears.)

Latchkey is primarily designed for AI agents. By invoking Latchkey, agents can
prompt the user to authenticate when needed, then continue interacting with
third-party APIs using standard curl syntax - no custom integrations or embedded
credentials required.

Unlike OAuth-based flows or typical MCP-style integrations, Latchkey does not
introduce an intermediary between the agent and the service. Requests are made
directly on the user’s behalf, which enables greater flexibility at the cost of
formal delegation: agents authenticate as the user.

If a service you need isn’t supported yet, contributions are welcome. Adding
support typically involves writing a small browser automation class that
extracts API credentials after login. See the [development docs](docs/development.md)
for details.

## Installation

### Prerequisites

- `curl` and `npm` need to be present in your system.
- A graphical environment is needed for the browser.


### Steps

1. Clone this repository to your local machine.
2. Enter the repository's directory.
3. `npm install -g .`

## Integrations

Warning: giving AI agents access to your API credentials is potentially
dangerous. They will be able to do most of the actions you can do. Only do this if
you're willing to accept the risks.


### OpenCode
```
mkdir -p ~/.opencode/skills/latchkey
cp integrations/SKILL.md ~/.opencode/skills/latchkey/SKILL.md
```

### Claude Code
```
mkdir -p ~/.claude/skills/latchkey
cp integrations/SKILL.md ~/.claude/skills/latchkey/SKILL.md
```

### Codex
```
mkdir -p ~/.codex/skills/latchkey
cp integrations/SKILL.md ~/.codex/skills/latchkey/SKILL.md
```


## Direct usage

Let's revisit the initial example:

```
latchkey curl -X POST 'https://slack.com/api/conversations.create' \
  -H 'Content-Type: application/json' \
  -d '{"name":"something-urgent"}'
```

Notice that `-H 'Authorization: Bearer` is absent. This is because Latchkey:

- Opens the browser with a login screen.
- After the user logs in, Latchkey extracts the necessary API credentials from the browser session.
- The browser is closed, the credentials are injected into the arguments and curl is invoked.
- The credentials are stored so that they can be reused the next time.

Otherwise, `latchkey curl` just directly passes your arguments
through to `curl` so you can use the same interface you are used
to. The return code, stdin and stdout are passed back from curl
to the caller of `latchkey`.

### Remembering API credentials

Your API credentials and browser state are by default stored under
`~/.latchkey`. You can override the individual locations by setting the
`LATCHKEY_STORE` and `LATCHKEY_BROWSER_STATE` environment variables. When a
functioning keyring is detected (which should be true on most systems), the
data is properly encrypted.


### Inspecting the status of stored credentials

Calling `latchkey status <service_name>` will give you
information about the status of remembered credentials for the
given service. It can be one of:

- `missing`
- `invalid`
- `valid`

### Clearing credentials

Remembered API credentials can expire. The caller of `latchkey
curl` will typically notice this because the calls will start returning
HTTP 401 or 403. To double-check that, first call `latchkey
status`, e.g.:

```
latchkey status discord
```

If the result is `invalid` (i.e., the Unauthorized / Forbidden
responses are caused by invalid or expired credentials as opposed
to insufficient permissions of the credential holder), force
a new login in the next `latchkey curl` call by clearing the
remembered API credentials for the service in question, e.g.:

```
latchkey clear discord
```

The next `latchkey curl` call will then trigger a new login flow.

To clear all stored data (both the credentials store and browser
state file), run:

```
latchkey clear
```


## Disclaimers

- Invoking `latchkey curl ...` can sometimes have side effects in the form of
  new API keys being created under your accounts (through browser automation).
- Using agents for automated access may be prohibited by some services' ToS.
