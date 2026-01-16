"""Integration tests for the CLI."""

import subprocess
from collections.abc import Sequence
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

from latchkey.cli import _extract_url_from_curl_arguments
from latchkey.cli import app
from latchkey.cli import reset_subprocess_runner
from latchkey.cli import set_subprocess_runner
from latchkey.services.slack import SlackCredentials

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


# Tests for _extract_url_from_curl_arguments


def test_extract_url_extracts_url_from_simple_arguments() -> None:
    arguments = ["https://example.com"]
    assert _extract_url_from_curl_arguments(arguments) == "https://example.com"


def test_extract_url_extracts_url_with_http_scheme() -> None:
    arguments = ["http://example.com"]
    assert _extract_url_from_curl_arguments(arguments) == "http://example.com"


def test_extract_url_extracts_url_after_options() -> None:
    arguments = ["-X", "POST", "https://api.example.com"]
    assert _extract_url_from_curl_arguments(arguments) == "https://api.example.com"


def test_extract_url_extracts_url_with_headers() -> None:
    arguments = ["-H", "Content-Type: application/json", "https://api.example.com"]
    assert _extract_url_from_curl_arguments(arguments) == "https://api.example.com"


def test_extract_url_extracts_url_with_data() -> None:
    arguments = ["-d", '{"key": "value"}', "https://api.example.com"]
    assert _extract_url_from_curl_arguments(arguments) == "https://api.example.com"


def test_extract_url_extracts_url_with_long_options() -> None:
    arguments = ["--header", "Authorization: Bearer token", "https://api.example.com"]
    assert _extract_url_from_curl_arguments(arguments) == "https://api.example.com"


def test_extract_url_extracts_url_with_equal_sign_format() -> None:
    arguments = ["--header=Content-Type: application/json", "https://api.example.com"]
    assert _extract_url_from_curl_arguments(arguments) == "https://api.example.com"


def test_extract_url_extracts_url_with_concatenated_short_option() -> None:
    arguments = ["-HContent-Type: application/json", "https://api.example.com"]
    assert _extract_url_from_curl_arguments(arguments) == "https://api.example.com"


def test_extract_url_returns_none_when_no_url() -> None:
    arguments = ["-X", "POST", "-H", "Content-Type: application/json"]
    assert _extract_url_from_curl_arguments(arguments) is None


def test_extract_url_returns_none_for_empty_arguments() -> None:
    arguments: list[str] = []
    assert _extract_url_from_curl_arguments(arguments) is None


def test_extract_url_skips_flags_without_values() -> None:
    arguments = ["-k", "--compressed", "-s", "-i", "https://api.example.com"]
    assert _extract_url_from_curl_arguments(arguments) == "https://api.example.com"


# Tests for credential injection


def test_curl_injects_credentials_for_slack_api() -> None:
    captured_args: list[str] = []

    def mock_runner(args: Sequence[str]) -> subprocess.CompletedProcess[bytes]:
        captured_args.extend(args)
        return subprocess.CompletedProcess(args=args, returncode=0)

    set_subprocess_runner(mock_runner)

    mock_credentials = SlackCredentials(token="xoxc-test-token", d_cookie="test-cookie")

    with patch("latchkey.cli.REGISTRY") as mock_registry:
        mock_service = MagicMock()
        mock_service.login.return_value = mock_credentials
        mock_registry.get_from_url.return_value = mock_service

        result = runner.invoke(app, ["curl", "https://slack.com/api/conversations.list"])

        mock_registry.get_from_url.assert_called_once_with("https://slack.com/api/conversations.list")
        mock_service.login.assert_called_once()

    assert result.exit_code == 0
    assert captured_args == [
        "curl",
        "-H",
        "Authorization: Bearer xoxc-test-token",
        "-H",
        "Cookie: d=test-cookie",
        "https://slack.com/api/conversations.list",
    ]


def test_curl_does_not_inject_credentials_for_unknown_service() -> None:
    captured_args: list[str] = []

    def mock_runner(args: Sequence[str]) -> subprocess.CompletedProcess[bytes]:
        captured_args.extend(args)
        return subprocess.CompletedProcess(args=args, returncode=0)

    set_subprocess_runner(mock_runner)

    with patch("latchkey.cli.REGISTRY") as mock_registry:
        mock_registry.get_from_url.return_value = None

        result = runner.invoke(app, ["curl", "https://unknown-api.example.com"])

        mock_registry.get_from_url.assert_called_once_with("https://unknown-api.example.com")

    assert result.exit_code == 0
    assert captured_args == ["curl", "https://unknown-api.example.com"]


def test_curl_does_not_inject_credentials_when_no_url_found() -> None:
    captured_args: list[str] = []

    def mock_runner(args: Sequence[str]) -> subprocess.CompletedProcess[bytes]:
        captured_args.extend(args)
        return subprocess.CompletedProcess(args=args, returncode=0)

    set_subprocess_runner(mock_runner)

    with patch("latchkey.cli.REGISTRY") as mock_registry:
        result = runner.invoke(app, ["curl", "--", "-X", "POST"])

        mock_registry.get_from_url.assert_not_called()

    assert result.exit_code == 0
    assert captured_args == ["curl", "-X", "POST"]


# Tests for match command


def test_match_prints_service_name_for_slack_url() -> None:
    with patch("latchkey.cli.REGISTRY") as mock_registry:
        mock_service = MagicMock()
        mock_service.name = "slack"
        mock_registry.get_from_url.return_value = mock_service

        result = runner.invoke(app, ["match", "https://slack.com/api/conversations.list"])

        mock_registry.get_from_url.assert_called_once_with("https://slack.com/api/conversations.list")

    assert result.exit_code == 0
    assert result.stdout.strip() == "slack"


def test_match_returns_error_for_unknown_service() -> None:
    with patch("latchkey.cli.REGISTRY") as mock_registry:
        mock_registry.get_from_url.return_value = None

        result = runner.invoke(app, ["match", "https://unknown-api.example.com"])

        mock_registry.get_from_url.assert_called_once_with("https://unknown-api.example.com")

    assert result.exit_code == 1
    assert "No service matches URL" in result.stderr
    assert "https://unknown-api.example.com" in result.stderr
    assert "latchkey services" in result.stderr


def test_match_returns_error_when_no_url_found() -> None:
    result = runner.invoke(app, ["match", "--", "-X", "POST"])

    assert result.exit_code == 1
    assert "Could not extract URL" in result.stderr


def test_match_works_with_complex_curl_arguments() -> None:
    with patch("latchkey.cli.REGISTRY") as mock_registry:
        mock_service = MagicMock()
        mock_service.name = "slack"
        mock_registry.get_from_url.return_value = mock_service

        result = runner.invoke(
            app,
            [
                "match",
                "--",
                "-X",
                "POST",
                "-H",
                "Content-Type: application/json",
                "https://slack.com/api/chat.postMessage",
            ],
        )

        mock_registry.get_from_url.assert_called_once_with("https://slack.com/api/chat.postMessage")

    assert result.exit_code == 0
    assert result.stdout.strip() == "slack"


def test_match_with_no_arguments() -> None:
    result = runner.invoke(app, ["match"])

    assert result.exit_code == 1
    assert "Could not extract URL" in result.stderr


def test_match_works_with_curl_options_without_double_dash() -> None:
    """Test that match works with curl options like -X without requiring --."""
    with patch("latchkey.cli.REGISTRY") as mock_registry:
        mock_service = MagicMock()
        mock_service.name = "slack"
        mock_registry.get_from_url.return_value = mock_service

        result = runner.invoke(
            app,
            [
                "match",
                "-X",
                "POST",
                "https://slack.com/api/conversations.create",
                "-H",
                "Content-Type: application/json",
                "-d",
                '{"name":"test-conversation"}',
            ],
        )

        mock_registry.get_from_url.assert_called_once_with("https://slack.com/api/conversations.create")

    assert result.exit_code == 0
    assert result.stdout.strip() == "slack"
