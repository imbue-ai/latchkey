"""Command-line interface for latchkey."""

import os
import shlex
from collections.abc import Sequence
from pathlib import Path
from typing import Annotated

import typer
import uncurl

from latchkey.api_credential_store import ApiCredentialStore
from latchkey.api_credentials import ApiCredentialStatus
from latchkey.browser_state import get_browser_state_path
from latchkey.curl import run as run_curl
from latchkey.registry import REGISTRY
from latchkey.services.base import LoginCancelledError
from latchkey.services.base import LoginFailedError

LATCHKEY_STORE_ENV_VAR = "LATCHKEY_STORE"

app = typer.Typer(
    help="A command-line tool that injects API credentials to curl requests to known public APIs.",
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
    """Get the API credential store path from environment variable."""
    env_value = os.environ.get(LATCHKEY_STORE_ENV_VAR)
    if env_value:
        return Path(env_value).expanduser()
    return None


@app.command()
def services() -> None:
    """List known and supported third-party services."""
    service_names = [service.name for service in REGISTRY.services]
    typer.echo(service_names)


def _clear_all(yes: bool) -> None:
    """Clear the entire credentials store and browser state file."""
    latchkey_store = _get_latchkey_store_path()
    browser_state = get_browser_state_path()

    files_to_delete: list[Path] = []
    if latchkey_store is not None and latchkey_store.exists():
        files_to_delete.append(latchkey_store)
    if browser_state is not None and browser_state.exists():
        files_to_delete.append(browser_state)

    if not files_to_delete:
        typer.echo("No files to delete.")
        return

    if not yes:
        typer.echo("This will delete the following files:")
        for file_path in files_to_delete:
            typer.echo(f"  {file_path}")

        confirmed = typer.confirm("Are you sure you want to continue?")
        if not confirmed:
            typer.echo("Aborted.")
            raise typer.Exit(code=1)

    for file_path in files_to_delete:
        file_path.unlink()
        if file_path == latchkey_store:
            typer.echo(f"Deleted credentials store: {file_path}")
        else:
            typer.echo(f"Deleted browser state: {file_path}")


def _clear_service(service_name: str) -> None:
    """Clear credentials for a specific service."""
    service = REGISTRY.get_by_name(service_name)
    if service is None:
        typer.echo(f"Error: Unknown service: {service_name}", err=True)
        typer.echo("Use 'latchkey services' to see available services.", err=True)
        raise typer.Exit(code=1)

    latchkey_store = _get_latchkey_store_path()
    if latchkey_store is None:
        typer.echo(f"Error: {LATCHKEY_STORE_ENV_VAR} environment variable is not set.", err=True)
        raise typer.Exit(code=1)

    api_credential_store = ApiCredentialStore(path=latchkey_store)
    deleted = api_credential_store.delete(service_name)

    if deleted:
        typer.echo(f"API credentials for {service_name} have been cleared.")
    else:
        typer.echo(f"No API credentials found for {service_name}.")


@app.command()
def clear(
    service_name: Annotated[
        str | None,
        typer.Argument(help="Name of the service to clear API credentials for. If omitted, clears all data."),
    ] = None,
    yes: Annotated[
        bool,
        typer.Option("--yes", "-y", help="Skip confirmation prompt when clearing all data."),
    ] = False,
) -> None:
    """Clear stored API credentials.

    If a service name is provided, clears credentials for that service only.
    If no service name is provided, deletes the entire credentials store and browser state file.

    Set LATCHKEY_STORE environment variable to specify the API credential store location.
    Set LATCHKEY_BROWSER_STATE environment variable to specify the browser state location.
    """
    if service_name is None:
        _clear_all(yes)
    else:
        _clear_service(service_name)


@app.command()
def status(
    service_name: Annotated[
        str,
        typer.Argument(help="Name of the service to check status for."),
    ],
) -> None:
    """Check the API credential status for a service.

    Returns one of: missing, valid, invalid.
    Set LATCHKEY_STORE environment variable to specify the API credential store location.
    """
    service = REGISTRY.get_by_name(service_name)
    if service is None:
        typer.echo(f"Error: Unknown service: {service_name}", err=True)
        typer.echo("Use 'latchkey services' to see available services.", err=True)
        raise typer.Exit(code=1)

    latchkey_store = _get_latchkey_store_path()
    if latchkey_store is None:
        typer.echo(ApiCredentialStatus.MISSING.value)
        return

    api_credential_store = ApiCredentialStore(path=latchkey_store)
    api_credentials = api_credential_store.get(service_name)

    if api_credentials is None:
        typer.echo(ApiCredentialStatus.MISSING.value)
        return

    api_credential_status = service.check_api_credentials(api_credentials)
    typer.echo(api_credential_status.value)


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
) -> None:
    """Run curl with API credential injection.

    Set LATCHKEY_STORE environment variable to persist API credentials to a file.
    """
    all_arguments = _collect_curl_arguments(curl_arguments, context)
    latchkey_store = _get_latchkey_store_path()

    url = _extract_url_from_curl_arguments(all_arguments)
    if url is not None:
        service = REGISTRY.get_by_url(url)
        if service is not None:
            api_credentials = None
            api_credential_store = ApiCredentialStore(path=latchkey_store) if latchkey_store else None

            if api_credential_store is not None:
                api_credentials = api_credential_store.get(service.name)

            if api_credentials is None:
                browser_state_path = get_browser_state_path()
                try:
                    api_credentials = service.get_session().login(browser_state_path=browser_state_path)
                except LoginCancelledError:
                    typer.echo("Login cancelled.", err=True)
                    raise typer.Exit(code=1)
                except LoginFailedError as error:
                    typer.echo(str(error), err=True)
                    raise typer.Exit(code=1)
                if api_credential_store is not None:
                    api_credential_store.save(service.name, api_credentials)

            all_arguments = list(api_credentials.as_curl_arguments()) + all_arguments

    result = run_curl(all_arguments)
    raise typer.Exit(code=result.returncode)


def entry_point() -> None:
    """Entry point for the CLI that exits with the appropriate code."""
    app()


if __name__ == "__main__":
    entry_point()
