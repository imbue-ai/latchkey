# Latchkey

A command-line tool that injects credentials to curl requests to known public APIs.

This is how it works:

- Call `latchkey services` to get a list of known and supported third-party services.
- Call `latchkey curl <arguments>` to retrieve and inject credentials to your otherwise standard curl calls to public APIs.
- Call `latchkey match <curl arguments>` to check if a given curl invocation matches any supported service.


## Example

```
latchkey curl -X POST 'https://slack.com/api/conversations.create' \
  -H 'Content-Type: application/json' \
  -d '{"name":"something-urgent"}'
```

Notice that `-H 'Authorization: Bearer` is absent. This is because latchkey:

- Opens the browser with a login screen.
- After the user logs in, latchkey extracts the necessary credentials from the browser session.
- The browser is closed, the credentials are injected into the arguments and curl is invoked.

Otherwise, `latchkey curl` just directly passes your arguments
through to `curl` so you can use the same interface you are used
to. The return code, stdin and stdout are passed back from curl
to the caller of `latchkey`.

### Remembering credentials

You can optionally set the `LATCHKEY_STORE` environment variable
to a path to a .json file that will be used to store the extracted
credentials. Next time you invoke a `latchkey curl` command
against the same service, the stored credentials will be reused.
While the file shouldn't contain any passwords (only tokens and
cookies), you should still treat it as a sensitive file.

```
export LATCHKEY_STORE=~/.latchkey/credentials.json
latchkey curl 'https://discord.com/api/v10/users/@me'
```


### Clearing credentials

Remembered credentials can be expired. The caller of `latchkey curl` will
typically notice this because the calls will return HTTP 401 or 403. To
force a new login, first clear the stored credentials:

```
latchkey clear discord
latchkey curl 'https://discord.com/api/v10/users/@me'
```

The next `latchkey curl` call will trigger a new login flow.

## Prerequisites

- `curl` needs to be installed in your system.
- A graphical environment is needed for the browser.


## Installation

1. Clone this repository to your local machine.
2. Enter the repository's directory.
3. `uv cache clean latchkey && uv tool install --force latchkey`
4. `uv run playwright install chromium`

## Tests

```
uv run pytest .
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

Warning: giving AI agents access to your credentials is
potentially dangerous. They will be able to do most of the
actions you can do. Only do this if you're willing to accept the
risk.

### Claude Code
```
mkdir -p ~/.claude/skills/latchkey
cp integrations/SKILL.md ~/.claude/skills/latchkey/SKILL.md
```

Optionally, add the following line to your `.bashrc` to remember logins:

```
export LATCHKEY_STORE=~/.latchkey/credentials.json
```
