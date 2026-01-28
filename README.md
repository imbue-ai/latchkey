# Latchkey

A command-line tool that injects credentials to curl requests to known public APIs.

This is how it works:

- Call `latchkey services` to get a list of known and supported third-party services.
- Call `latchkey curl <arguments>` to retrieve and inject credentials to your otherwise standard curl calls to public APIs.


## Example

```
latchkey curl -X POST 'https://slack.com/api/conversations.create' \
  -H 'Content-Type: application/json' \
  -d '{"name":"something-urgent"}'
```

Notice that `-H 'Authorization: Bearer` is absent. This is because latchkey:

- Opens the browser with a login screen.
- After the user logs in, latchkey extracts the necessary API credentials from the browser session.
- The browser is closed, the credentials are injected into the arguments and curl is invoked.

Otherwise, `latchkey curl` just directly passes your arguments
through to `curl` so you can use the same interface you are used
to. The return code, stdin and stdout are passed back from curl
to the caller of `latchkey`.

### Remembering API credentials

Your API credentials and browser state are stored for later
reuse, by default under `~/.latchkey.` You can override the
individual locations by setting the `LATCHKEY_STORE` and
`LATCHKEY_BROWSER_STATE` environment variables. When easily
possible (a functioning keyring is detected, which should be
true on most systems), the data is stored in an encrypted form.


### Inspecting the status of remembered credentials

Calling `latchkey status <service_name>` will give you
information about the status of remembered credentials for the
given service. It can be one of:

- missing
- invalid
- valid

### Clearing credentials

Remembered API credentials can expire. The caller of `latchkey
curl` will typically notice this because the calls will return
HTTP 401 or 403. To double-check that, first call `latchkey
status`, e.g.:

```
latchkey status discord
```

If the answer is `invalid`, force a new login in the next `latchkey
curl` call by clearing the remembered API credentials for the service
in question, e.g.:

```
latchkey clear discord
```

The next `latchkey curl` call will then trigger a new login flow.

To clear all stored data (both the credentials store and browser
state file), run:

```
latchkey clear
```

## Prerequisites

- `curl` and `npm` need to be installed in your system.
- A graphical environment is needed for the browser.


## Installation

1. Clone this repository to your local machine.
2. Enter the repository's directory.
3. `npm install -g .`

## Tests

```
npm test
```


## Use cases

### Personal AI assistant

Imagine a locally running personal AI assistant that can help
users with their everyday work. Users can ask for assistance
with their e-mail, tickets, messages or other things, many of
which can entail interactions with a third-party service through
their public API.

Latchkey can be used as a convenient wrapper for API calls to
ensure that the agent is authenticated to access resources on
user's behalf.

By re-using the well-known interface of `curl`, it should be
relatively easy for pre-trained models to come up with proper
invocations.

## Integrations

Warning: giving AI agents access to your API credentials is
potentially dangerous. They will be able to do most of the
actions you can do. Only do this if you're willing to accept the
risk.

### Claude Code
```
mkdir -p ~/.claude/skills/latchkey
cp integrations/SKILL.md ~/.claude/skills/latchkey/SKILL.md
```
