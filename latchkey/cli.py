"""Command-line interface for latchkey."""

import shlex
import subprocess
import sys
from collections.abc import Callable
from collections.abc import Sequence
from typing import Annotated

import typer
import uncurl

from latchkey.registry import REGISTRY

app = typer.Typer(
    help="A command-line tool that injects credentials to curl requests to known public APIs.",
)

# Type alias for the subprocess runner function
SubprocessRunner = Callable[[Sequence[str]], subprocess.CompletedProcess[bytes]]


def _default_subprocess_runner(args: Sequence[str]) -> subprocess.CompletedProcess[bytes]:
    """Default subprocess runner that calls the real subprocess.run."""
    return subprocess.run(args, capture_output=False)


# Global subprocess runner that can be replaced for testing
_subprocess_runner: SubprocessRunner = _default_subprocess_runner


def set_subprocess_runner(runner: SubprocessRunner) -> None:
    """Set the subprocess runner function. Used for testing."""
    global _subprocess_runner
    _subprocess_runner = runner


def reset_subprocess_runner() -> None:
    """Reset the subprocess runner to the default. Used for testing."""
    global _subprocess_runner
    _subprocess_runner = _default_subprocess_runner


def _extract_url_from_curl_arguments(arguments: Sequence[str]) -> str | None:
    """Extract the URL from curl command-line arguments using uncurl."""
    curl_command = "curl " + " ".join(shlex.quote(arg) for arg in arguments)
    try:
        context = uncurl.parse_context(curl_command)
        return context.url if context.url else None
    except SystemExit:
        # uncurl raises SystemExit for invalid/unparseable commands
        return None


def _collect_curl_arguments(curl_arguments: list[str] | None, context: typer.Context) -> list[str]:
    # Typer splits arguments around "--": those before go into curl_arguments,
    # those after go into context.args. Concatenate them to get all arguments.
    return list(curl_arguments or []) + context.args


@app.command()
def services() -> None:
    """List known and supported third-party services."""
    print("[]")


@app.command(
    context_settings={"allow_extra_args": True, "allow_interspersed_args": False},
)
def match(
    context: typer.Context,
    curl_arguments: Annotated[
        list[str] | None,
        typer.Argument(help="Arguments to pass to curl (for URL extraction)."),
    ] = None,
) -> None:
    """Print the name of the service that matches the given curl invocation."""
    all_arguments = _collect_curl_arguments(curl_arguments, context)

    url = _extract_url_from_curl_arguments(all_arguments)
    if url is None:
        print("Error: Could not extract URL from curl arguments.", file=sys.stderr)
        raise typer.Exit(code=1)

    service = REGISTRY.get_from_url(url)
    if service is None:
        print(f"Error: No service matches URL: {url}", file=sys.stderr)
        print("Use 'latchkey services' to see available services.", file=sys.stderr)
        raise typer.Exit(code=1)

    print(service.name)


@app.command(
    context_settings={"allow_extra_args": True, "allow_interspersed_args": False},
)
def curl(
    context: typer.Context,
    curl_arguments: Annotated[
        list[str] | None,
        typer.Argument(help="Arguments to pass to curl."),
    ] = None,
) -> None:
    """Run curl with credential injection."""
    all_arguments = _collect_curl_arguments(curl_arguments, context)

    url = _extract_url_from_curl_arguments(all_arguments)
    if url is not None:
        service = REGISTRY.get_from_url(url)
        if service is not None:
            credentials = service.login()
            all_arguments = list(credentials.as_curl_arguments()) + all_arguments

    result = _subprocess_runner(["curl", *all_arguments])
    raise typer.Exit(code=result.returncode)


def entry_point() -> None:
    """Entry point for the CLI that exits with the appropriate code."""
    app()


if __name__ == "__main__":
    entry_point()
