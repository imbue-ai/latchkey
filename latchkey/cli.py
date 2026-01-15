"""Command-line interface for latchkey."""

import subprocess
from collections.abc import Callable
from collections.abc import Sequence
from typing import Annotated

import typer

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
    result = _subprocess_runner(["curl", *all_arguments])
    raise typer.Exit(code=result.returncode)


def entry_point() -> None:
    """Entry point for the CLI that exits with the appropriate code."""
    app()


if __name__ == "__main__":
    entry_point()
