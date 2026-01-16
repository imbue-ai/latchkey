#!/usr/bin/env python3
"""Record a browser login session for later replay.

This script opens a browser at a service's login URL and records all network
traffic and browser state. When you close the browser, the recording is saved.
This is useful for recording login flows that can be replayed later for testing.

Usage:
    uv run scripts/record_login.py <SERVICE_NAME>

Example:
    uv run scripts/record_login.py slack

The recording is saved to scripts/recordings/<service_name>/ with:
- recording.har: Network traffic (HTTP Archive format)
- recording.state.json: Browser state (cookies, localStorage, etc.)


Recordings Directory Structure
------------------------------

Recordings are organized in subdirectories named after the service they belong
to. The service name must match a name from the global service registry (see
latchkey/registry.py). For example:

    recordings/
        slack/
            recording.har
            recording.state.json
        discord/
            recording.har
            recording.state.json


Running the Tests
-----------------

To run all tests including recording tests:

    uv run pytest

To run only recording tests:

    uv run pytest tests/test_recordings.py

To test a specific service:

    uv run pytest tests/test_recordings.py -k slack


How the Tests Work
------------------

The test script uses Playwright's routeFromHAR feature to replay the recorded
network traffic. This means:

1. The browser loads with the saved state (cookies, localStorage)
2. When the browser makes network requests, Playwright serves responses from
   the HAR file instead of making real network calls
3. The service's wait_for_login_completed() and extract_credentials() methods
   are called against this replayed session

This allows testing credential extraction logic without needing live network
access or valid credentials.


Important Notes
---------------

1. Recordings are .gitignored because:
   - They can be large (HAR files can contain many network requests)
   - They contain sensitive data (credentials, tokens, cookies)

2. Each recording directory should contain:
   - recording.har: Required for replaying network traffic
   - recording.state.json: Required for restoring browser state

3. The test script validates that:
   - The service's wait_for_login_completed() method succeeds
   - The service's extract_credentials() method returns valid credentials

4. If a test fails, it usually means:
   - The recording is incomplete (login wasn't fully completed)
   - The service implementation has changed
   - The service's website has changed its login flow

5. HAR replay limitations:
   - Playwright matches requests by URL and HTTP method (and POST body for POSTs)
   - Dynamic parameters (timestamps, nonces) may cause mismatches
   - If requests don't match, they fall back to real network calls
"""

import json
from pathlib import Path
from typing import Annotated

import typer
from playwright.sync_api import sync_playwright

from latchkey.registry import REGISTRY
from latchkey.services import Service

# Default maximum size for media content in HAR files (1MB)
DEFAULT_MAX_MEDIA_SIZE_BYTES = 1024 * 1024

# Recordings directory relative to this script
RECORDINGS_DIRECTORY = Path(__file__).parent / "recordings"


class UnknownServiceError(Exception):
    pass


# Media MIME type prefixes to filter
MEDIA_MIME_PREFIXES = ("image/", "video/", "audio/")


def _filter_har_media(har_path: Path, max_size_bytes: int = DEFAULT_MAX_MEDIA_SIZE_BYTES) -> None:
    """Filter out large media content from a HAR file.

    Removes base64-encoded content from responses that:
    - Have a media MIME type (image/*, video/*, audio/*)
    - Have content larger than max_size_bytes
    """
    with open(har_path) as file:
        har_data = json.load(file)

    entries = har_data.get("log", {}).get("entries", [])
    for entry in entries:
        response = entry.get("response", {})
        content = response.get("content", {})

        mime_type = content.get("mimeType", "")
        is_media = any(mime_type.startswith(prefix) for prefix in MEDIA_MIME_PREFIXES)

        if is_media:
            # Check size - either from size field or from base64 text length
            size = content.get("size", 0)
            text = content.get("text", "")
            if size > max_size_bytes or len(text) > max_size_bytes:
                # Remove the content but keep metadata
                content["text"] = ""
                content["comment"] = f"Content removed by latchkey (size: {size} bytes)"

    with open(har_path, "w") as file:
        json.dump(har_data, file, indent=2)


def _get_service_by_name(name: str) -> Service:
    """Get a service from the registry by name."""
    for service in REGISTRY.services:
        if service.name == name:
            return service
    raise UnknownServiceError(f"Unknown service: {name}")


def _record(
    service_name: str,
    max_media_size: int,
) -> None:
    """Record a browser session for later replay."""
    service = _get_service_by_name(service_name)

    output_directory = RECORDINGS_DIRECTORY / service_name
    output_directory.mkdir(parents=True, exist_ok=True)
    har_path = output_directory / "recording.har"
    state_path = output_directory / "recording.state.json"

    typer.echo(f"Recording login for service: {service.name}")
    typer.echo(f"Login URL: {service.login_url}")
    typer.echo(f"Output directory: {output_directory}")
    typer.echo("\nClose the browser window when you're done to save the recording.")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=False)
        context = browser.new_context(record_har_path=str(har_path))
        page = context.new_page()

        page.goto(service.login_url)

        # Wait for user to close the browser
        try:
            # This will block until the page/context is closed
            page.wait_for_event("close", timeout=0)
        except Exception:
            # Browser was closed, this is expected
            pass

        # Save browser state (cookies, localStorage, etc.)
        context.storage_state(path=str(state_path))

        # Close context to finalize HAR file
        context.close()
        browser.close()

    # Filter out large media from HAR file
    if har_path.exists():
        _filter_har_media(har_path, max_media_size)
        typer.echo("\nRecording saved successfully!")
        typer.echo(f"  HAR file: {har_path}")
        typer.echo(f"  State file: {state_path}")
    else:
        typer.echo("\nWarning: HAR file was not created.", err=True)


def main(
    service_name: Annotated[
        str,
        typer.Argument(help="Name of the service to record login for (e.g., 'slack', 'discord')."),
    ],
    max_media_size: Annotated[
        int,
        typer.Option(
            "--max-media-size",
            help="Maximum size in bytes for media content in HAR. Larger content is removed.",
        ),
    ] = DEFAULT_MAX_MEDIA_SIZE_BYTES,
) -> None:
    """Record a browser login session for later replay.

    Opens a browser at the service's login URL and records all network traffic
    and browser state. When you close the browser, the recording is saved.
    This is useful for recording login flows that can be replayed later for testing.

    The recording is saved to scripts/recordings/<service_name>/ with:

    - recording.har: Network traffic (HTTP Archive format)

    - recording.state.json: Browser state (cookies, localStorage, etc.)
    """
    _record(
        service_name=service_name,
        max_media_size=max_media_size,
    )


if __name__ == "__main__":
    typer.run(main)
