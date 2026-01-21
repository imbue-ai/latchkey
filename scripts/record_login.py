#!/usr/bin/env python3
"""Record browser requests and responses during a login session.

This script opens a browser at a service's login URL and records all HTTP
requests and responses (including their headers and timing). When you close the
browser, the recording is saved. This is useful for recording login flows that
can be replayed later for testing credentials extraction.

(NOTE: this only works for a subset of services.
 Some services need additional credentials extraction steps.)

Usage:
    uv run scripts/record_login.py <SERVICE_NAME>

Example:
    uv run scripts/record_login.py slack

The recording is saved to scripts/recordings/<service_name>/ with:
- requests.json: HTTP requests and responses with headers and timing


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


Recording Format
----------------

Each entry is recorded as a JSON object with:
- request: The HTTP request details
  - timestamp_ms: Milliseconds since recording started
  - method: HTTP method (GET, POST, etc.)
  - url: Full request URL
  - headers: Dictionary of request headers
  - post_data: POST body if present (for POST/PUT/PATCH requests)
  - resource_type: Type of resource (document, xhr, fetch, etc.)
- response: The HTTP response details
  - status: HTTP status code
  - status_text: HTTP status text
  - headers: Dictionary of response headers
  - body: Response body (text only, omitted for binary content)

Note: Requests for CSS, images, fonts, and multimedia are skipped.
"""

import json
import time
from pathlib import Path
from typing import Annotated
from typing import Any
from urllib.parse import urlparse

import typer
from playwright.sync_api import Response
from playwright.sync_api import sync_playwright

from latchkey.browser_state import get_browser_state_path
from latchkey.registry import REGISTRY

# Recordings directory relative to this script
RECORDINGS_DIRECTORY = Path(__file__).parent / "recordings"


class UnknownServiceError(Exception):
    pass


# Resource types to skip (CSS, images, fonts, multimedia)
SKIPPED_RESOURCE_TYPES = frozenset(
    {
        "stylesheet",
        "image",
        "media",
        "font",
    }
)


def _extract_base_domain(url: str) -> str:
    """Extract the base domain from a URL.

    For example:
        https://discord.com/login -> discord.com
        https://api.discord.com/v9/users -> discord.com
        https://www.example.co.uk/page -> example.co.uk
    """
    hostname = urlparse(url).hostname or ""

    # Split the hostname into parts
    parts = hostname.split(".")

    # Handle common multi-part TLDs (e.g., co.uk, com.au)
    # For simplicity, we'll assume the base domain is the last two parts
    # unless it's a known multi-part TLD
    multi_part_tlds = {"co.uk", "com.au", "co.nz", "co.jp", "com.br", "co.in"}

    if len(parts) >= 3:
        potential_tld = ".".join(parts[-2:])
        if potential_tld in multi_part_tlds:
            return ".".join(parts[-3:])

    if len(parts) >= 2:
        return ".".join(parts[-2:])

    return hostname


def _is_same_base_domain(request_url: str, base_domain: str) -> bool:
    """Check if a request URL belongs to the same base domain."""
    request_hostname = urlparse(request_url).hostname or ""
    return request_hostname == base_domain or request_hostname.endswith("." + base_domain)


def _handle_response(
    response: Response,
    recorded_entries: list[dict[str, Any]],
    start_time: list[float],
    base_domain: str,
) -> None:
    """Handle a response and record both request and response details."""
    request = response.request

    # Skip CSS, images, fonts, and multimedia
    if request.resource_type in SKIPPED_RESOURCE_TYPES:
        return

    # Skip requests to external domains
    if not _is_same_base_domain(request.url, base_domain):
        return

    if start_time[0] == 0.0:
        start_time[0] = time.time()

    timestamp_ms = int((time.time() - start_time[0]) * 1000)

    request_data: dict[str, Any] = {
        "timestamp_ms": timestamp_ms,
        "method": request.method,
        "url": request.url,
        "headers": request.all_headers(),
        "resource_type": request.resource_type,
    }

    # Include POST data if present and decodable / non-compressed.
    try:
        post_data = request.post_data
    except UnicodeDecodeError:
        post_data = None
    if post_data is not None:
        request_data["post_data"] = post_data

    response_data: dict[str, Any] = {
        "status": response.status,
        "status_text": response.status_text,
        "headers": response.all_headers(),
    }

    # Try to get response body as text (skip binary content)
    try:
        body = response.text()
        response_data["body"] = body
    except Exception:
        # Binary content or other error - skip body
        pass

    recorded_entries.append(
        {
            "request": request_data,
            "response": response_data,
        }
    )


def _record(service_name: str) -> None:
    """Record browser requests and responses during a login session."""
    service = REGISTRY.get_by_name(service_name)
    if service is None:
        raise UnknownServiceError(f"Unknown service: {service_name}")

    output_directory = RECORDINGS_DIRECTORY / service_name
    output_directory.mkdir(parents=True, exist_ok=True)
    requests_path = output_directory / "requests.json"

    browser_state_path = get_browser_state_path()

    base_domain = _extract_base_domain(service.login_url)

    typer.echo(f"Recording login for service: {service.name}")
    typer.echo(f"Login URL: {service.login_url}")
    typer.echo(f"Recording requests to: {base_domain} (and subdomains)")
    typer.echo(f"Output directory: {output_directory}")
    if browser_state_path:
        typer.echo(f"Browser state: {browser_state_path}")
    typer.echo("\nClose the browser window when you're done to save the recording.")

    recorded_entries: list[dict[str, Any]] = []
    start_time: list[float] = [0.0]

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=False)
        context = browser.new_context(
            storage_state=str(browser_state_path) if browser_state_path and browser_state_path.exists() else None
        )
        page = context.new_page()

        # Register response handler to capture all requests and responses
        page.on(
            "response",
            lambda response: _handle_response(response, recorded_entries, start_time, base_domain),
        )

        page.goto(service.login_url)

        # Wait for user to close the browser
        try:
            # This will block until the page/context is closed
            page.wait_for_event("close", timeout=0)
        except Exception:
            # Browser was closed, this is expected
            pass

        # Save browser state if path is configured
        if browser_state_path:
            try:
                context.storage_state(path=str(browser_state_path))
            except Exception:
                # Context may already be closed
                pass

        context.close()
        browser.close()

    # Save recorded entries
    with open(requests_path, "w") as file:
        json.dump(recorded_entries, file, indent=2)

    typer.echo("\nRecording saved successfully!")
    typer.echo(f"  Requests file: {requests_path}")
    typer.echo(f"  Recorded {len(recorded_entries)} request/response pairs")


def main(
    service_name: Annotated[
        str,
        typer.Argument(help="Name of the service to record login for (e.g., 'slack', 'discord')."),
    ],
) -> None:
    """Record browser requests and responses during a login session.

    Opens a browser at the service's login URL and records all HTTP requests
    and responses including their headers and timing. When you close the
    browser, the recording is saved.

    The recording is saved to scripts/recordings/<service_name>/ with:

    - requests.json: HTTP requests and responses with headers and timing
    """
    _record(service_name=service_name)


if __name__ == "__main__":
    typer.run(main)
