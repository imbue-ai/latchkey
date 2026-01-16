"""Command-line interface for latchkey."""

import shlex
import subprocess
from collections.abc import Callable
from collections.abc import Sequence
from pathlib import Path
from typing import Annotated

import typer
import uncurl

from latchkey.credential_store import CredentialStore
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
    typer.echo("[]")


@app.command(
    context_settings={
        "allow_extra_args": True,
        "allow_interspersed_args": False,
        "ignore_unknown_options": True,
    },
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
        typer.echo("Error: Could not extract URL from curl arguments.", err=True)
        raise typer.Exit(code=1)

    service = REGISTRY.get_by_url(url)
    if service is None:
        typer.echo(f"Error: No service matches URL: {url}", err=True)
        typer.echo("Use 'latchkey services' to see available services.", err=True)
        raise typer.Exit(code=1)

    typer.echo(service.name)


@app.command(
    context_settings={
        "allow_extra_args": True,
        "allow_interspersed_args": False,
        "ignore_unknown_options": True,
    },
)
def curl(
    context: typer.Context,
    curl_arguments: Annotated[
        list[str] | None,
        typer.Argument(help="Arguments to pass to curl."),
    ] = None,
    latchkey_store: Annotated[
        Path | None,
        typer.Option(
            "--latchkey-store",
            help="Path to store/load serialized credentials for all services.",
        ),
    ] = None,
) -> None:
    """Run curl with credential injection."""
    all_arguments = _collect_curl_arguments(curl_arguments, context)

    url = _extract_url_from_curl_arguments(all_arguments)
    if url is not None:
        service = REGISTRY.get_by_url(url)
        if service is not None:
            credentials = None
            credential_store = CredentialStore(path=latchkey_store) if latchkey_store else None

            if credential_store is not None:
                credentials = credential_store.get(service.name)

            if credentials is None:
                credentials = service.login()
                if credential_store is not None:
                    credential_store.save(service.name, credentials)

            all_arguments = list(credentials.as_curl_arguments()) + all_arguments

    result = _subprocess_runner(["curl", *all_arguments])
    raise typer.Exit(code=result.returncode)


def entry_point() -> None:
    """Entry point for the CLI that exits with the appropriate code."""
    app()


if __name__ == "__main__":
    entry_point()
