"""Test login recordings against service implementations.

This module validates that recorded login sessions can be used to test
service API credential extraction logic. It discovers recordings in
scripts/recordings/<service_name>/ and verifies that the service's
_get_api_credentials_from_outgoing_request() method can extract valid API credentials
from the recorded requests.

The tests work by loading recorded HTTP request/response pairs from requests.json
and creating mock Request objects to pass to the service's API credential extraction
method. This validates that the service can correctly identify and extract
API credentials from outgoing browser requests.

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

from latchkey.api_credentials import ApiCredentials
from latchkey.registry import REGISTRY
from latchkey.services import Service
from latchkey.services.base import SimpleServiceSession
from scripts.record_browser_session import DEFAULT_RECORDING_NAME

RECORDINGS_DIRECTORY = Path(__file__).parent.parent / "scripts" / "recordings"

# Do not test services that require special followup steps.
BLACKLIST = ("dropbox", "github", "linear",)


class InvalidRecordingError(Exception):
    pass


class ApiCredentialExtractionError(Exception):
    pass


def _load_recording_entries(requests_path: Path) -> list[dict[str, Any]]:
    """Load recorded request/response entries from JSON file."""
    with open(requests_path) as file:
        return json.load(file)


def _create_mock_request(request_data: dict[str, Any]) -> Mock:
    """Create a mock Playwright Request object from recorded request data."""
    mock_request = Mock()
    mock_request.url = request_data["url"]
    mock_request.method = request_data["method"]
    mock_request.headers = request_data["headers"]
    mock_request.all_headers.return_value = request_data["headers"]
    mock_request.resource_type = request_data.get("resource_type", "other")
    mock_request.post_data = request_data.get("post_data")
    return mock_request


def _create_mock_response(response_data: dict[str, Any], mock_request: Mock) -> Mock:
    """Create a mock Playwright Response object from recorded response data."""
    mock_response = Mock()
    mock_response.status = response_data.get("status", 200)
    mock_response.status_text = response_data.get("status_text", "OK")
    mock_response.headers = response_data.get("headers", {})
    mock_response.all_headers.return_value = response_data.get("headers", {})
    mock_response.request = mock_request

    body = response_data.get("body")
    mock_response.text.return_value = body if body is not None else ""

    return mock_response


def _test_service_with_recording(
    service: Service,
    recording_directory: Path,
) -> ApiCredentials:
    """Test a service's API credential extraction using a recorded session.

    Loads recorded HTTP request/response pairs and tests that the service can
    extract API credentials from them using _get_api_credentials_from_response().
    """
    requests_path = recording_directory / DEFAULT_RECORDING_NAME

    if not requests_path.exists():
        raise InvalidRecordingError(f"Requests file not found: {requests_path}")

    recording_entries = _load_recording_entries(requests_path)
    if not recording_entries:
        raise InvalidRecordingError("No requests recorded")

    session = service.get_session()
    if not isinstance(session, SimpleServiceSession):
        pass

    # Try to extract API credentials from each recorded request/response pair
    for entry in recording_entries:
        request_data = entry["request"]
        response_data = entry.get("response", {})
        mock_request = _create_mock_request(request_data)
        mock_response = _create_mock_response(response_data, mock_request)
        api_credentials = session._get_api_credentials_from_response(mock_response)
        if api_credentials is not None:
            return api_credentials

    raise ApiCredentialExtractionError(
        f"No API credentials could be extracted from {len(recording_entries)} recorded entries"
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
        if item.is_dir() and not item.name.startswith(".") and item.name not in BLACKLIST:
            requests_path = item / DEFAULT_RECORDING_NAME
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
    """Test that a recorded login session produces valid API credentials."""
    service = REGISTRY.get_by_name(service_name)
    if service is None:
        pytest.skip(f"Service '{service_name}' not found in registry")

    api_credentials = _test_service_with_recording(service, recording_path)

    # Verify API credentials are valid
    assert api_credentials is not None, "extract_api_credentials returned None"
    curl_args = api_credentials.as_curl_arguments()
    assert curl_args, "API credentials produced no curl arguments"
