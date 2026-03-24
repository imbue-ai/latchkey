import shlex
import shutil
import subprocess

import llm


class LatchkeyError(Exception):
    pass


def _find_latchkey() -> str:
    path = shutil.which("latchkey")
    if path is None:
        raise LatchkeyError(
            "Latchkey is not installed. Install it with: npm install -g latchkey"
        )
    return path


def latchkey(command: str) -> str:
    """Run a latchkey command. Latchkey injects stored API credentials into curl commands for third-party services.

Available commands:
- `services list --viable` — List services with configured credentials.
- `services info <service_name>` — Get auth options, credential status, and API docs links for a service.
- `curl <curl_arguments>` — Make an authenticated HTTP request. Pass standard curl arguments; credentials are injected automatically.
- `auth browser <service_name>` — Open a browser login popup to authenticate (only if credentials are missing/invalid).

Usage:
1. Start with `services list --viable` to discover configured services.
2. Use `services info <service_name>` to learn about the API and check credential status.
3. Use `curl <args>` to make requests — do NOT include Authorization headers, latchkey adds them.
4. If you get HTTP 401/403, check `services info` — if credentials are invalid, use `auth browser`.
5. Do NOT initiate a login if credential status is `valid` or `unknown`.

Important: Do NOT use shell features like $(...), backticks, or variable expansion in commands — they will not be interpreted. Compute any dynamic values (like dates) yourself and inline them directly.

Examples:
- `services list --viable`
- `services info slack`
- `curl https://api.github.com/user`
- `curl -X POST 'https://slack.com/api/conversations.create' -H 'Content-Type: application/json' -d '{"name":"my-channel"}'`
- `curl 'https://api.linear.app/graphql' -X POST -H 'Content-Type: application/json' -d '{"query": "{ viewer { assignedIssues(first: 10) { nodes { title state { name } } } } }"}'`
- `curl 'https://discord.com/api/v10/users/@me'`

Supported services include: AWS, Discord, Dropbox, GitHub, GitLab, Gmail, Google Calendar, Google Docs, Google Drive, Google Sheets, Linear, Notion, Sentry, Slack, Stripe, Telegram, Zoom, and more."""
    latchkey_path = _find_latchkey()
    try:
        arguments = shlex.split(command)
    except ValueError as error:
        return f"Error parsing command: {error}"

    timeout = 60 if arguments and arguments[0] == "curl" else 30
    result = subprocess.run(
        [latchkey_path, *arguments],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    output = result.stdout.strip()
    error = result.stderr.strip()
    if result.returncode != 0:
        return f"Error (exit code {result.returncode}): {error or output}"
    if error and output:
        return f"{output}\n\n(stderr: {error})"
    return output or error or "(empty response)"


@llm.hookimpl
def register_tools(register):
    register(latchkey)
