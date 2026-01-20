"""Command-line interface for latchkey."""

import os
import shlex
from collections.abc import Sequence
from pathlib import Path
from typing import Annotated

import typer
import uncurl

from latchkey import curl as curl_module
from latchkey.credential_store import CredentialStore
from latchkey.credentials import CredentialStatus
from latchkey.registry import REGISTRY
from latchkey.services.base import LoginCancelledError

LATCHKEY_STORE_ENV_VAR = "LATCHKEY_STORE"

app = typer.Typer(
    help="A command-line tool that injects credentials to curl requests to known public APIs.",
)


# Curl flags that don't affect the HTTP request semantics but aren't supported by uncurl.
# These are filtered out before passing to uncurl for URL extraction.
_CURL_PASSTHROUGH_FLAGS = frozenset({"-v", "--verbose"})


def _filter_passthrough_flags(arguments: Sequence[str]) -> list[str]:
    """Filter out curl flags that uncurl doesn't understand but don't affect URL extraction."""
    return [arg for arg in arguments if arg not in _CURL_PASSTHROUGH_FLAGS]


def _extract_url_from_curl_arguments(arguments: Sequence[str]) -> str | None:
    """Extract the URL from curl command-line arguments using uncurl."""
    filtered_arguments = _filter_passthrough_flags(arguments)
    curl_command = "curl " + " ".join(shlex.quote(arg) for arg in filtered_arguments)
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


def _get_latchkey_store_path() -> Path | None:
    """Get the credential store path from environment variable."""
    env_value = os.environ.get(LATCHKEY_STORE_ENV_VAR)
    if env_value:
        return Path(env_value).expanduser()
    return None


@app.command()
def services() -> None:
    """List known and supported third-party services."""
    service_names = [service.name for service in REGISTRY.services]
    typer.echo(service_names)


@app.command()
def status(
    service_name: Annotated[
        str,
        typer.Argument(help="Name of the service to check status for."),
    ],
) -> None:
    """Check the credential status for a service.

    Returns one of: missing, valid, invalid.
    Set LATCHKEY_STORE environment variable to specify the credential store location.
    """
    service = REGISTRY.get_by_name(service_name)
    if service is None:
        typer.echo(f"Error: Unknown service: {service_name}", err=True)
        typer.echo("Use 'latchkey services' to see available services.", err=True)
        raise typer.Exit(code=1)

    latchkey_store = _get_latchkey_store_path()
    if latchkey_store is None:
        typer.echo(CredentialStatus.MISSING.value)
        return

    credential_store = CredentialStore(path=latchkey_store)
    credentials = credential_store.get(service_name)

    if credentials is None:
        typer.echo(CredentialStatus.MISSING.value)
        return

    credential_status = service.check_credentials(credentials)
    typer.echo(credential_status.value)


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
    force_login: Annotated[
        bool,
        typer.Option("--latchkey-force-login", help="Force re-authentication even if credentials exist."),
    ] = False,
    curl_arguments: Annotated[
        list[str] | None,
        typer.Argument(help="Arguments to pass to curl."),
    ] = None,
) -> None:
    """Run curl with credential injection.

    Set LATCHKEY_STORE environment variable to persist credentials to a file.
    """
    all_arguments = _collect_curl_arguments(curl_arguments, context)
    latchkey_store = _get_latchkey_store_path()

    url = _extract_url_from_curl_arguments(all_arguments)
    if url is not None:
        service = REGISTRY.get_by_url(url)
        if service is not None:
            credentials = None
            credential_store = CredentialStore(path=latchkey_store) if latchkey_store else None

            if credential_store is not None and not force_login:
                credentials = credential_store.get(service.name)

            if credentials is None:
                try:
                    credentials = service.login()
                except LoginCancelledError:
                    typer.echo("Login cancelled.", err=True)
                    raise typer.Exit(code=1)
                if credential_store is not None:
                    credential_store.save(service.name, credentials)

            all_arguments = list(credentials.as_curl_arguments()) + all_arguments

    result = curl_module.run(all_arguments)
    raise typer.Exit(code=result.returncode)


def entry_point() -> None:
    """Entry point for the CLI that exits with the appropriate code."""
    app()


if __name__ == "__main__":
    entry_point()
