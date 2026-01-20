"""Test login recordings against service implementations.

This module validates that recorded login sessions can be used to test
service credential extraction logic. It discovers recordings in
scripts/recordings/<service_name>/ and verifies that the service's
_get_credentials_from_outgoing_request() method can extract valid credentials
from the recorded requests.

The tests work by loading recorded HTTP requests from requests.json and
creating mock Request objects to pass to the service's credential extraction
method. This validates that the service can correctly identify and extract
credentials from outgoing browser requests.

Usage:
    uv run pytest tests/test_services_against_recordings.py           # Test all recordings
    uv run pytest tests/test_services_against_recordings.py -v        # Verbose output
    uv run pytest tests/test_services_against_recordings.py -k slack  # Test only Slack
"""

import json
from pathlib import Path
from typing import Any
from unittest.mock import Mock

import pytest

from latchkey.credentials import Credentials
from latchkey.registry import REGISTRY
from latchkey.services import Service

RECORDINGS_DIRECTORY = Path(__file__).parent.parent / "scripts" / "recordings"


class InvalidRecordingError(Exception):
    pass


class CredentialExtractionError(Exception):
    pass


def _load_requests(requests_path: Path) -> list[dict[str, Any]]:
    """Load recorded requests from JSON file."""
    with open(requests_path) as file:
        return json.load(file)


def _create_mock_request(request_data: dict[str, Any]) -> Mock:
    """Create a mock Playwright Request object from recorded request data."""
    mock_request = Mock()
    mock_request.url = request_data["url"]
    mock_request.method = request_data["method"]
    mock_request.headers = request_data["headers"]
    mock_request.resource_type = request_data.get("resource_type", "other")
    mock_request.post_data = request_data.get("post_data")
    return mock_request


def _test_service_with_recording(
    service: Service,
    recording_directory: Path,
) -> Credentials:
    """Test a service's credential extraction using a recorded session.

    Loads recorded HTTP requests and tests that the service can extract
    credentials from them using _get_credentials_from_outgoing_request().
    """
    requests_path = recording_directory / "requests.json"

    if not requests_path.exists():
        raise InvalidRecordingError(f"Requests file not found: {requests_path}")

    recorded_requests = _load_requests(requests_path)
    if not recorded_requests:
        raise InvalidRecordingError("No requests recorded")

    # Try to extract credentials from each recorded request
    for request_data in recorded_requests:
        mock_request = _create_mock_request(request_data)
        credentials = service._get_credentials_from_outgoing_request(mock_request)
        if credentials is not None:
            return credentials

    raise CredentialExtractionError(
        f"No credentials could be extracted from {len(recorded_requests)} recorded requests"
    )


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
            requests_path = item / "requests.json"
            if requests_path.exists():
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
