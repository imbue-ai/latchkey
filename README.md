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
- After the user logs in, latchkey extracts the necessary API credentials from the browser session.
- The browser is closed, the credentials are injected into the arguments and curl is invoked.

Otherwise, `latchkey curl` just directly passes your arguments
through to `curl` so you can use the same interface you are used
to. The return code, stdin and stdout are passed back from curl
to the caller of `latchkey`.

### Remembering API credentials

You can optionally set the `LATCHKEY_STORE` environment variable
to a path to a .json file that will be used to store the extracted
API credentials. Next time you invoke a `latchkey curl` command
against the same service, the stored credentials will be reused.
While the file shouldn't contain any passwords (only tokens and
cookies), you should still treat it as a sensitive file.

```
export LATCHKEY_STORE=~/.latchkey/api_credentials.json
latchkey curl 'https://discord.com/api/v10/users/@me'
```

### Reusing browser state

You can optionally set the `LATCHKEY_BROWSER_STATE` environment
variable to a path to a .json file that will be used to persist
browser state (cookies, local storage) across Playwright sessions.
This can speed up subsequent logins by reusing authentication
state from previous browser sessions.

```
export LATCHKEY_BROWSER_STATE=~/.latchkey/browser_state.json
latchkey curl 'https://discord.com/api/v10/users/@me'
```

The browser state is loaded when the login browser opens and saved
after a successful login.


### Clearing credentials

Remembered API credentials can expire. The caller of `latchkey
curl` will typically notice this because the calls will return
HTTP 401 or 403. To force a new login in the next `latchkey
curl` call, clear the remembered API credentials for the service
in question, e.g.:

```
latchkey clear discord
```

The next `latchkey curl` call will then trigger a new login flow.

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

Warning: giving AI agents access to your API credentials is
potentially dangerous. They will be able to do most of the
actions you can do. Only do this if you're willing to accept the
risk.

### Claude Code
```
mkdir -p ~/.claude/skills/latchkey
cp integrations/SKILL.md ~/.claude/skills/latchkey/SKILL.md
```

Optionally, add the following lines to your `.bashrc` to remember logins and browser state:

```
export LATCHKEY_STORE=~/.latchkey/api_credentials.json
export LATCHKEY_BROWSER_STATE=~/.latchkey/browser_state.json
```
