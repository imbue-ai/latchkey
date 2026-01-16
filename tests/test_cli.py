"""Integration tests for the CLI."""

import subprocess
from collections.abc import Sequence

import pytest
from typer.testing import CliRunner

from latchkey.cli import app
from latchkey.cli import reset_subprocess_runner
from latchkey.cli import set_subprocess_runner

runner = CliRunner()


@pytest.fixture(autouse=True)
def reset_runner_after_test():
    """Reset the subprocess runner after each test."""
    yield
    reset_subprocess_runner()


def test_curl_passes_arguments_to_subprocess() -> None:
    """Test that arguments are correctly passed to curl subprocess."""
    captured_args: list[str] = []

    def mock_runner(args: Sequence[str]) -> subprocess.CompletedProcess[bytes]:
        captured_args.extend(args)
        return subprocess.CompletedProcess(args=args, returncode=0)

    set_subprocess_runner(mock_runner)

    result = runner.invoke(app, ["curl", "https://example.com"])

    assert captured_args == ["curl", "https://example.com"]
    assert result.exit_code == 0


def test_curl_passes_multiple_arguments() -> None:
    """Test that multiple arguments are passed correctly."""
    captured_args: list[str] = []

    def mock_runner(args: Sequence[str]) -> subprocess.CompletedProcess[bytes]:
        captured_args.extend(args)
        return subprocess.CompletedProcess(args=args, returncode=0)

    set_subprocess_runner(mock_runner)

    # Use -- to separate curl arguments from latchkey options
    result = runner.invoke(
        app, ["curl", "--", "-X", "POST", "-H", "Content-Type: application/json", "https://api.example.com"]
    )

    assert captured_args == ["curl", "-X", "POST", "-H", "Content-Type: application/json", "https://api.example.com"]
    assert result.exit_code == 0


def test_curl_returns_subprocess_exit_code() -> None:
    """Test that the exit code from subprocess is returned."""

    def mock_runner(args: Sequence[str]) -> subprocess.CompletedProcess[bytes]:
        return subprocess.CompletedProcess(args=args, returncode=42)

    set_subprocess_runner(mock_runner)

    result = runner.invoke(app, ["curl", "https://example.com"])

    assert result.exit_code == 42


def test_curl_returns_nonzero_exit_code() -> None:
    """Test that non-zero exit codes are properly propagated."""

    def mock_runner(args: Sequence[str]) -> subprocess.CompletedProcess[bytes]:
        return subprocess.CompletedProcess(args=args, returncode=1)

    set_subprocess_runner(mock_runner)

    result = runner.invoke(app, ["curl", "https://example.com"])

    assert result.exit_code == 1


def test_curl_with_no_arguments() -> None:
    """Test curl command with no arguments."""
    captured_args: list[str] = []

    def mock_runner(args: Sequence[str]) -> subprocess.CompletedProcess[bytes]:
        captured_args.extend(args)
        return subprocess.CompletedProcess(args=args, returncode=0)

    set_subprocess_runner(mock_runner)

    result = runner.invoke(app, ["curl"])

    assert captured_args == ["curl"]
    assert result.exit_code == 0


def test_curl_with_extra_args_via_context() -> None:
    """Test that extra arguments from context are appended."""
    captured_args: list[str] = []

    def mock_runner(args: Sequence[str]) -> subprocess.CompletedProcess[bytes]:
        captured_args.extend(args)
        return subprocess.CompletedProcess(args=args, returncode=0)

    set_subprocess_runner(mock_runner)

    result = runner.invoke(app, ["curl", "--", "-v", "https://example.com"])

    assert "curl" in captured_args
    assert "-v" in captured_args
    assert "https://example.com" in captured_args
    assert result.exit_code == 0
