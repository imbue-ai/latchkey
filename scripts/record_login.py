#!/usr/bin/env python3
"""Record outgoing browser requests during a login session.

This script opens a browser at a service's login URL and records all outgoing
HTTP requests (including their headers and timing). When you close the browser,
the recording is saved. This is useful for recording login flows that can be
replayed later for testing credentials extraction.

Usage:
    uv run scripts/record_login.py <SERVICE_NAME>

Example:
    uv run scripts/record_login.py slack

The recording is saved to scripts/recordings/<service_name>/ with:
- requests.json: Outgoing HTTP requests with headers and timing


Recordings Directory Structure
------------------------------

Recordings are organized in subdirectories named after the service they belong
to. The service name must match a name from the global service registry (see
latchkey/registry.py). For example:

    recordings/
        slack/
            requests.json
        discord/
            requests.json


Request Recording Format
------------------------

Each request is recorded as a JSON object with:
- timestamp_ms: Milliseconds since recording started
- method: HTTP method (GET, POST, etc.)
- url: Full request URL
- headers: Dictionary of request headers
- post_data: POST body if present (for POST/PUT/PATCH requests)
- resource_type: Type of resource (document, xhr, fetch, etc.)
"""

import json
import time
from pathlib import Path
from typing import Annotated
from typing import Any

import typer
from playwright.sync_api import Request
from playwright.sync_api import sync_playwright

from latchkey.registry import REGISTRY

# Recordings directory relative to this script
RECORDINGS_DIRECTORY = Path(__file__).parent / "recordings"


class UnknownServiceError(Exception):
    pass


def _handle_request(
    request: Request,
    recorded_requests: list[dict[str, Any]],
    start_time: list[float],
) -> None:
    """Handle a single outgoing request and record its details."""
    if start_time[0] == 0.0:
        start_time[0] = time.time()

    timestamp_ms = int((time.time() - start_time[0]) * 1000)

    request_data: dict[str, Any] = {
        "timestamp_ms": timestamp_ms,
        "method": request.method,
        "url": request.url,
        "headers": dict(request.headers),
        "resource_type": request.resource_type,
    }

    # Include POST data if present
    post_data = request.post_data
    if post_data is not None:
        request_data["post_data"] = post_data

    recorded_requests.append(request_data)


def _record(service_name: str) -> None:
    """Record outgoing browser requests during a login session."""
    service = REGISTRY.get_by_name(service_name)
    if service is None:
        raise UnknownServiceError(f"Unknown service: {service_name}")

    output_directory = RECORDINGS_DIRECTORY / service_name
    output_directory.mkdir(parents=True, exist_ok=True)
    requests_path = output_directory / "requests.json"

    typer.echo(f"Recording login for service: {service.name}")
    typer.echo(f"Login URL: {service.login_url}")
    typer.echo(f"Output directory: {output_directory}")
    typer.echo("\nClose the browser window when you're done to save the recording.")

    recorded_requests: list[dict[str, Any]] = []
    start_time: list[float] = [0.0]

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=False)
        context = browser.new_context()
        page = context.new_page()

        # Register request handler to capture all outgoing requests
        page.on(
            "request",
            lambda request: _handle_request(request, recorded_requests, start_time),
        )

        page.goto(service.login_url)

        # Wait for user to close the browser
        try:
            # This will block until the page/context is closed
            page.wait_for_event("close", timeout=0)
        except Exception:
            # Browser was closed, this is expected
            pass

        context.close()
        browser.close()

    # Save recorded requests
    with open(requests_path, "w") as file:
        json.dump(recorded_requests, file, indent=2)

    typer.echo("\nRecording saved successfully!")
    typer.echo(f"  Requests file: {requests_path}")
    typer.echo(f"  Recorded {len(recorded_requests)} requests")


def main(
    service_name: Annotated[
        str,
        typer.Argument(help="Name of the service to record login for (e.g., 'slack', 'discord')."),
    ],
) -> None:
    """Record outgoing browser requests during a login session.

    Opens a browser at the service's login URL and records all outgoing HTTP
    requests including their headers and timing. When you close the browser,
    the recording is saved.

    The recording is saved to scripts/recordings/<service_name>/ with:

    - requests.json: Outgoing HTTP requests with headers and timing
    """
    _record(service_name=service_name)


if __name__ == "__main__":
    typer.run(main)
