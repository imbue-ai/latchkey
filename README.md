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
	- Get a list of known and supported third-party services (Slack, Discord, Linear, GitHub, etc.).
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

- `curl`, `node` and `npm` need to be present on your system in reasonably recent versions.
- The browser requires a graphical environment.

### Steps

```
npm install -g latchkey
```

**nvm users**: Global packages are per node version. If you switch versions, reinstall with `npm install -g latchkey`

## Integrations

Warning: giving AI agents access to your API credentials is potentially
dangerous. They will be able to perform most of the actions you can. Only do this if
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


## Demo

![Image](https://github.com/user-attachments/assets/784bd7eb-6d34-4cab-97d3-4a0f8c4ca9aa)


## Direct usage

Let's revisit the initial example:

```
latchkey curl -X POST 'https://slack.com/api/conversations.create' \
  -H 'Content-Type: application/json' \
  -d '{"name":"something-urgent"}'
```

Notice that `-H 'Authorization: Bearer ...'` is absent. This is because Latchkey:

- Opens the browser with a login screen.
- After the user logs in, Latchkey extracts the necessary API credentials from the browser session.
- The browser is closed, the credentials are injected into the arguments, and `curl` is invoked.
- The credentials are stored so that they can be reused the next time.

Otherwise, `latchkey curl` passes your arguments straight
through to `curl` so you can use the same interface you are used
to. The return code, stdin and stdout are passed back from curl
to the caller of `latchkey`.

### Remembering API credentials

Your API credentials and browser state are stored by default
under `~/.latchkey`. When a functioning keyring is detected
(which is the case on most systems), the data is properly
encrypted.


### Inspecting the status of stored credentials

Calling `latchkey status <service_name>` will give you
information about the status of remembered credentials for the
given service. Possible results are:

- `missing`
- `invalid`
- `valid`

### Clearing credentials

Remembered API credentials can expire. The caller of `latchkey
curl` will typically notice this because the calls will start returning
HTTP 401 or 403. To verify that, first call `latchkey status`, e.g.:

```
latchkey status discord
```

If the result is `invalid` , meaning the Unauthorized/Forbidden responses are
caused by invalid or expired credentials rather than insufficient permissions,
force a new login in the next `latchkey curl` call by clearing the remembered
API credentials for the service in question, e.g.:

```
latchkey clear discord
```

The next `latchkey curl` call will then trigger a new login flow.

To clear all stored data (both the credentials store and browser
state file), run:

```
latchkey clear
```

### Advanced configuration

You can set these environment variables to override certain
defaults:

- `LATCHKEY_STORE`: path to the (typically encrypted) file
containing stored API credentials
- `LATCHKEY_BROWSER_STATE`: path to the (typically encrypted) file
containing the state (cookies, local storage, etc.) of
the browser used for the login popup
- `LATCHKEY_CURL_PATH`: path to the curl binary
- `LATCHKEY_KEYRING_SERVICE_NAME`, `LATCHKEY_KEYRING_ACCOUNT_NAME`: identifiers that are used to store the encryption password in your keyring


## Disclaimers

- This is still a work in progress.
- Latchkey has been created with the help of AI-assisted coding tools with careful human curation.
- Invoking `latchkey curl ...` can sometimes have side effects in the form of
  new API keys being created in your accounts (through browser automation).
- Using agents for automated access may be prohibited by some services' ToS.
- We reserve the right to change the license of future releases of Latchkey.
- Latchkey was not tested on Windows.
