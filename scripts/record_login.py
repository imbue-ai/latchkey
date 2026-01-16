#!/usr/bin/env python3
"""Record a browser login session for later replay.

This script opens a browser at a service's login URL and records all network
traffic and user actions. When you close the browser, the recording is saved.
This is useful for recording login flows that can be replayed later for testing.

Usage:
    uv run scripts/record_login.py <SERVICE_NAME>

Example:
    uv run scripts/record_login.py slack

The recording is saved to scripts/recordings/<service_name>/ with:
- recording.har: Network traffic (HTTP Archive format)
- recording.actions.json: User actions (clicks, typing, navigation)


Recordings Directory Structure
------------------------------

Recordings are organized in subdirectories named after the service they belong
to. The service name must match a name from the global service registry (see
latchkey/registry.py). For example:

    recordings/
        slack/
            recording.har
            recording.actions.json
        discord/
            recording.har
            recording.actions.json


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

The test script replays recorded user actions while using Playwright's
routeFromHAR feature to serve the recorded network responses. This means:

1. The browser starts with a fresh state (no cookies, no localStorage)
2. User actions (clicks, typing) are replayed to simulate the login flow
3. When the browser makes network requests, Playwright serves responses from
   the HAR file instead of making real network calls
4. The service's wait_for_login_completed() and extract_credentials() methods
   are called against this replayed session

This allows testing the full login flow including state transitions, without
needing live network access or valid credentials.


Important Notes
---------------

1. Recordings are .gitignored because:
   - They can be large (HAR files can contain many network requests)
   - They contain sensitive data (credentials, tokens, cookies)

2. Each recording directory should contain:
   - recording.har: Required for replaying network traffic
   - recording.actions.json: Required for replaying user actions

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

6. Action replay limitations:
   - Actions are replayed using CSS selectors captured at record time
   - If the page structure changes, selectors may not match
   - Timing-sensitive interactions may need adjustment
"""

import json
from pathlib import Path
from typing import Annotated
from typing import Any

import typer
from playwright.sync_api import Page
from playwright.sync_api import sync_playwright

from latchkey.registry import REGISTRY

# Default maximum size for media content in HAR files (1MB)
DEFAULT_MAX_MEDIA_SIZE_BYTES = 1024 * 1024

# Recordings directory relative to this script
RECORDINGS_DIRECTORY = Path(__file__).parent / "recordings"


class UnknownServiceError(Exception):
    pass


# Media MIME type prefixes to filter
MEDIA_MIME_PREFIXES = ("image/", "video/", "audio/")

# JavaScript to inject for recording user actions
ACTION_RECORDER_SCRIPT = """
window.__recordedActions = window.__recordedActions || [];
window.__actionStartTime = window.__actionStartTime || Date.now();

function getSelector(element) {
    // Try to get a unique, stable selector for the element
    if (element.id) {
        return '#' + CSS.escape(element.id);
    }

    // Try data-testid or other test attributes
    for (const attr of ['data-testid', 'data-test-id', 'data-cy', 'data-test']) {
        if (element.hasAttribute(attr)) {
            return '[' + attr + '="' + CSS.escape(element.getAttribute(attr)) + '"]';
        }
    }

    // Try name attribute for form elements
    if (element.name && ['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA'].includes(element.tagName)) {
        const selector = element.tagName.toLowerCase() + '[name="' + CSS.escape(element.name) + '"]';
        if (document.querySelectorAll(selector).length === 1) {
            return selector;
        }
    }

    // Try aria-label
    if (element.hasAttribute('aria-label')) {
        const selector = '[aria-label="' + CSS.escape(element.getAttribute('aria-label')) + '"]';
        if (document.querySelectorAll(selector).length === 1) {
            return selector;
        }
    }

    // Try type + placeholder for inputs
    if (element.tagName === 'INPUT' && element.placeholder) {
        const selector = 'input[placeholder="' + CSS.escape(element.placeholder) + '"]';
        if (document.querySelectorAll(selector).length === 1) {
            return selector;
        }
    }

    // Fall back to building a path with nth-child
    const path = [];
    let current = element;
    while (current && current !== document.body) {
        let selector = current.tagName.toLowerCase();
        if (current.parentElement) {
            const siblings = Array.from(current.parentElement.children).filter(
                c => c.tagName === current.tagName
            );
            if (siblings.length > 1) {
                const index = siblings.indexOf(current) + 1;
                selector += ':nth-of-type(' + index + ')';
            }
        }
        path.unshift(selector);
        current = current.parentElement;
    }
    return 'body > ' + path.join(' > ');
}

function recordAction(action) {
    action.timestamp = Date.now() - window.__actionStartTime;
    action.url = window.location.href;
    window.__recordedActions.push(action);
}

// Record clicks
document.addEventListener('click', function(e) {
    const target = e.target;
    recordAction({
        type: 'click',
        selector: getSelector(target),
        tagName: target.tagName,
        text: target.innerText?.substring(0, 100) || null
    });
}, true);

// Record input/typing with debounce (record final value, not each keystroke)
const inputTimers = new WeakMap();
document.addEventListener('input', function(e) {
    const target = e.target;
    if (!['INPUT', 'TEXTAREA'].includes(target.tagName)) return;

    // Clear previous timer for this element
    if (inputTimers.has(target)) {
        clearTimeout(inputTimers.get(target));
    }

    // Set new timer to record after typing stops
    inputTimers.set(target, setTimeout(function() {
        recordAction({
            type: 'fill',
            selector: getSelector(target),
            value: target.value,
            inputType: target.type || 'text'
        });
    }, 500));
}, true);

// Record form submissions
document.addEventListener('submit', function(e) {
    recordAction({
        type: 'submit',
        selector: getSelector(e.target)
    });
}, true);

// Record select changes
document.addEventListener('change', function(e) {
    const target = e.target;
    if (target.tagName === 'SELECT') {
        recordAction({
            type: 'select',
            selector: getSelector(target),
            value: target.value
        });
    }
}, true);
"""


def _install_action_recorder(page: Page) -> None:
    """Install the action recorder script on a page."""
    page.add_init_script(ACTION_RECORDER_SCRIPT)


def _get_recorded_actions(page: Page) -> list[dict[str, Any]]:
    """Retrieve recorded actions from the page."""
    try:
        actions = page.evaluate("window.__recordedActions || []")
        return actions if isinstance(actions, list) else []
    except Exception:
        return []


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


def _record(
    service_name: str,
    max_media_size: int,
) -> None:
    """Record a browser session for later replay."""
    service = REGISTRY.get_by_name(service_name)
    if service is None:
        raise UnknownServiceError(f"Unknown service: {service_name}")

    output_directory = RECORDINGS_DIRECTORY / service_name
    output_directory.mkdir(parents=True, exist_ok=True)
    har_path = output_directory / "recording.har"
    actions_path = output_directory / "recording.actions.json"

    typer.echo(f"Recording login for service: {service.name}")
    typer.echo(f"Login URL: {service.login_url}")
    typer.echo(f"Output directory: {output_directory}")
    typer.echo("\nClose the browser window when you're done to save the recording.")

    recorded_actions: list[dict[str, Any]] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=False)
        context = browser.new_context(record_har_path=str(har_path))
        page = context.new_page()

        # Install the action recorder script (runs on every page load)
        _install_action_recorder(page)

        # Record the initial navigation as an action
        recorded_actions.append(
            {
                "type": "goto",
                "url": service.login_url,
                "timestamp": 0,
            }
        )

        page.goto(service.login_url)

        # Wait for user to close the browser
        try:
            # This will block until the page/context is closed
            page.wait_for_event("close", timeout=0)
        except Exception:
            # Browser was closed, this is expected
            pass

        # Collect recorded actions before closing
        recorded_actions.extend(_get_recorded_actions(page))

        # Close context to finalize HAR file
        context.close()
        browser.close()

    # Filter out large media from HAR file
    if har_path.exists():
        _filter_har_media(har_path, max_media_size)

        # Save recorded actions
        with open(actions_path, "w") as file:
            json.dump(recorded_actions, file, indent=2)

        typer.echo("\nRecording saved successfully!")
        typer.echo(f"  HAR file: {har_path}")
        typer.echo(f"  Actions file: {actions_path}")
        typer.echo(f"  Recorded {len(recorded_actions)} actions")
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
    and user actions. When you close the browser, the recording is saved.
    This is useful for recording login flows that can be replayed later for testing.

    The recording is saved to scripts/recordings/<service_name>/ with:

    - recording.har: Network traffic (HTTP Archive format)

    - recording.actions.json: User actions (clicks, typing, navigation)
    """
    _record(
        service_name=service_name,
        max_media_size=max_media_size,
    )


if __name__ == "__main__":
    typer.run(main)
