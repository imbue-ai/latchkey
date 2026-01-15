"""Command-line interface for latchkey."""

import subprocess
from typing import Annotated

import typer

app = typer.Typer(
    help="A command-line tool that injects credentials to curl requests to known public APIs.",
)


@app.command()
def services() -> None:
    """List known and supported third-party services."""
    print("[]")


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
    all_arguments = list(curl_arguments or []) + context.args
    result = subprocess.run(
        ["curl", *all_arguments],
        capture_output=False,
    )
    raise typer.Exit(code=result.returncode)


def entry_point() -> None:
    """Entry point for the CLI that exits with the appropriate code."""
    app()


if __name__ == "__main__":
    entry_point()
