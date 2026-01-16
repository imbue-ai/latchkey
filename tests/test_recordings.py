"""Test login recordings against service implementations.

This module validates that recorded login sessions can be used to test
service credential extraction logic. It discovers recordings in
scripts/recordings/<service_name>/ and verifies that:

1. The service's wait_for_login_completed() method succeeds
2. The service's extract_credentials() method returns valid credentials

The tests work by replaying recorded user actions (clicks, typing) while
serving network responses from the recorded HAR file. This simulates the
actual login flow rather than just loading a pre-authenticated state.

Usage:
    uv run pytest tests/test_recordings.py           # Test all recordings
    uv run pytest tests/test_recordings.py -v        # Verbose output
    uv run pytest tests/test_recordings.py -k slack  # Test only Slack
"""

import json
from pathlib import Path
from typing import Any

import pytest
from playwright.sync_api import Page
from playwright.sync_api import sync_playwright

from latchkey.credentials import Credentials
from latchkey.registry import REGISTRY
from latchkey.services import Service

RECORDINGS_DIRECTORY = Path(__file__).parent.parent / "scripts" / "recordings"


class InvalidRecordingError(Exception):
    pass


class LoginDetectionError(Exception):
    pass


class CredentialExtractionError(Exception):
    pass


class ActionReplayError(Exception):
    pass


def _load_actions(actions_path: Path) -> list[dict[str, Any]]:
    """Load recorded actions from JSON file."""
    with open(actions_path) as file:
        return json.load(file)


def _replay_action(page: Page, action: dict[str, Any]) -> None:
    """Replay a single recorded action on the page."""
    action_type = action.get("type")

    if action_type == "goto":
        page.goto(action["url"], wait_until="domcontentloaded")

    elif action_type == "click":
        selector = action.get("selector")
        if selector:
            try:
                page.click(selector, timeout=5000)
            except Exception:
                # If selector fails, try to find by text as fallback
                text = action.get("text")
                if text:
                    page.get_by_text(text[:50]).first.click(timeout=5000)
                else:
                    raise

    elif action_type == "fill":
        selector = action.get("selector")
        value = action.get("value", "")
        if selector:
            page.fill(selector, value, timeout=5000)

    elif action_type == "select":
        selector = action.get("selector")
        value = action.get("value", "")
        if selector:
            page.select_option(selector, value, timeout=5000)

    elif action_type == "submit":
        # Form submission is usually triggered by a click, so we may not need
        # to do anything special here. The click on submit button handles it.
        pass


def _replay_actions(page: Page, actions: list[dict[str, Any]]) -> None:
    """Replay all recorded actions on the page."""
    for action in actions:
        _replay_action(page, action)


def _test_service_with_recording(
    service: Service,
    recording_directory: Path,
) -> Credentials:
    """Test a service's credential extraction using a recorded session.

    Replays recorded user actions while using Playwright's routeFromHAR to
    serve the recorded network responses. This simulates the actual login flow.
    """
    har_path = recording_directory / "recording.har"
    actions_path = recording_directory / "recording.actions.json"

    if not har_path.exists():
        raise InvalidRecordingError(f"HAR file not found: {har_path}")
    if not actions_path.exists():
        raise InvalidRecordingError(f"Actions file not found: {actions_path}")

    actions = _load_actions(actions_path)
    if not actions:
        raise InvalidRecordingError("No actions recorded")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        # Start with fresh context (no pre-loaded state)
        context = browser.new_context()

        # Use Playwright's built-in HAR replay for network requests
        context.route_from_har(str(har_path), not_found="fallback")

        page = context.new_page()
        page.set_default_timeout(10000)

        try:
            _replay_actions(page, actions)
        except Exception as error:
            raise ActionReplayError(f"Failed to replay actions: {error}") from error

        try:
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
            actions_path = item / "recording.actions.json"
            if har_path.exists() and actions_path.exists():
                recordings.append((item.name, item))

    return recordings


# Discover recordings at module load time for pytest parametrization
_DISCOVERED_RECORDINGS = _discover_recordings()


@pytest.mark.parametrize(
    "service_name,recording_path",
    _DISCOVERED_RECORDINGS,
    ids=[name for name, _ in _DISCOVERED_RECORDINGS],
)
def test_recording(service_name: str, recording_path: Path) -> None:
    """Test that a recorded login session produces valid credentials."""
    service = REGISTRY.get_by_name(service_name)
    if service is None:
        pytest.skip(f"Service '{service_name}' not found in registry")

    credentials = _test_service_with_recording(service, recording_path)

    # Verify credentials are valid
    assert credentials is not None, "extract_credentials returned None"
    curl_args = credentials.as_curl_arguments()
    assert curl_args, "Credentials produced no curl arguments"
