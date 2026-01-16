"""Test login recordings against service implementations.

This module validates that recorded login sessions can be used to test
service credential extraction logic. It discovers recordings in
dev/recordings/<service_name>/ and verifies that:

1. The service's wait_for_login_completed() method succeeds
2. The service's extract_credentials() method returns valid credentials

Usage:
    uv run pytest dev/test_recordings.py           # Test all recordings
    uv run pytest dev/test_recordings.py -v        # Verbose output
    uv run pytest dev/test_recordings.py -k slack  # Test only Slack
"""

import json
from pathlib import Path

import pytest
from playwright.sync_api import sync_playwright

from latchkey.credentials import Credentials
from latchkey.registry import REGISTRY
from latchkey.services.base import Service

RECORDINGS_DIRECTORY = Path(__file__).parent / "recordings"


class InvalidRecordingError(Exception):
    pass


class LoginDetectionError(Exception):
    pass


class CredentialExtractionError(Exception):
    pass


def _get_first_url_from_har(har_path: Path) -> str | None:
    """Get the first URL from HAR file (initial navigation)."""
    with open(har_path) as file:
        har_data = json.load(file)
    entries = har_data.get("log", {}).get("entries", [])
    for entry in entries:
        request = entry.get("request", {})
        url = request.get("url", "")
        if url:
            return url
    return None


def _test_service_with_recording(
    service: Service,
    recording_directory: Path,
) -> Credentials:
    """Test a service's credential extraction using a recorded session.

    Uses Playwright's routeFromHAR to replay all recorded network requests,
    combined with the saved browser state (cookies, localStorage).
    """
    har_path = recording_directory / "recording.har"
    state_path = recording_directory / "recording.state.json"

    if not har_path.exists():
        raise InvalidRecordingError(f"HAR file not found: {har_path}")
    if not state_path.exists():
        raise InvalidRecordingError(f"State file not found: {state_path}")

    first_url = _get_first_url_from_har(har_path)
    if not first_url:
        raise InvalidRecordingError("Could not determine start URL from HAR")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(storage_state=str(state_path))

        # Use Playwright's built-in HAR replay
        # This replays all recorded network responses matching URL and method
        context.route_from_har(str(har_path), not_found="fallback")

        page = context.new_page()
        page.goto(first_url, wait_until="domcontentloaded")

        try:
            # Use a short timeout since we're using recorded state
            page.set_default_timeout(5000)
            service.wait_for_login_completed(page)
        except Exception as error:
            raise LoginDetectionError(f"wait_for_login_completed failed: {error}") from error

        try:
            credentials = service.extract_credentials(page)
        except Exception as error:
            raise CredentialExtractionError(f"extract_credentials failed: {error}") from error

        browser.close()

    return credentials


def _discover_recordings() -> list[tuple[str, Path]]:
    """Discover all recording directories.

    Returns:
        List of (service_name, recording_path) tuples.
    """
    recordings: list[tuple[str, Path]] = []

    if not RECORDINGS_DIRECTORY.exists():
        return recordings

    for item in sorted(RECORDINGS_DIRECTORY.iterdir()):
        if item.is_dir() and not item.name.startswith("."):
            har_path = item / "recording.har"
            state_path = item / "recording.state.json"
            if har_path.exists() and state_path.exists():
                recordings.append((item.name, item))

    return recordings


def _get_service_by_name(name: str) -> Service | None:
    """Get a service from the registry by name."""
    for service in REGISTRY.services:
        if service.name == name:
            return service
    return None


# Discover recordings at module load time for pytest parametrization
_DISCOVERED_RECORDINGS = _discover_recordings()


@pytest.mark.parametrize(
    "service_name,recording_path",
    _DISCOVERED_RECORDINGS,
    ids=[name for name, _ in _DISCOVERED_RECORDINGS],
)
def test_recording(service_name: str, recording_path: Path) -> None:
    """Test that a recorded login session produces valid credentials."""
    service = _get_service_by_name(service_name)
    if service is None:
        pytest.skip(f"Service '{service_name}' not found in registry")

    credentials = _test_service_with_recording(service, recording_path)

    # Verify credentials are valid
    assert credentials is not None, "extract_credentials returned None"
    curl_args = credentials.as_curl_arguments()
    assert curl_args, "Credentials produced no curl arguments"
