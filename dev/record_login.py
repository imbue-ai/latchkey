#!/usr/bin/env python3
"""Record a browser login session for later replay.

This script opens a browser at a given URL and records all network traffic
and browser state. When you close the browser, the recording is saved.
This is useful for recording login flows that can be replayed later.

Usage:
    uv run dev/record_login.py <URL> [OPTIONS]

Example:
    uv run dev/record_login.py https://slack.com/signin -o ./recordings -n slack-login

The recording consists of two files:
- {name}.har: Network traffic (HTTP Archive format)
- {name}.state.json: Browser state (cookies, localStorage, etc.)
"""

import json
import sys
from pathlib import Path
from typing import Annotated

import typer
from playwright.sync_api import sync_playwright

# Default maximum size for media content in HAR files (1MB)
DEFAULT_MAX_MEDIA_SIZE_BYTES = 1024 * 1024

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


def _record(
    url: str,
    output_directory: Path,
    recording_name: str,
    max_media_size: int,
) -> None:
    """Record a browser session for later replay."""
    output_directory.mkdir(parents=True, exist_ok=True)
    har_path = output_directory / f"{recording_name}.har"
    state_path = output_directory / f"{recording_name}.state.json"

    print(f"Recording browser session to: {output_directory}")
    print(f"  HAR file: {har_path}")
    print(f"  State file: {state_path}")
    print("\nClose the browser window when you're done to save the recording.")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=False)
        context = browser.new_context(record_har_path=str(har_path))
        page = context.new_page()

        page.goto(url)

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
        print(f"\nRecording saved successfully!")
        print(f"  HAR file: {har_path}")
        print(f"  State file: {state_path}")
    else:
        print("\nWarning: HAR file was not created.", file=sys.stderr)


def main(
    url: Annotated[str, typer.Argument(help="URL to open (typically a login URL).")],
    output: Annotated[
        Path,
        typer.Option(
            "--output",
            "-o",
            help="Directory to save the recording.",
        ),
    ] = Path("."),
    name: Annotated[
        str,
        typer.Option(
            "--name",
            "-n",
            help="Name for the recording files.",
        ),
    ] = "recording",
    max_media_size: Annotated[
        int,
        typer.Option(
            "--max-media-size",
            help="Maximum size in bytes for media content in HAR. Larger content is removed.",
        ),
    ] = DEFAULT_MAX_MEDIA_SIZE_BYTES,
) -> None:
    """Record a browser login session for later replay.

    Opens a browser at the given URL and records all network traffic and browser
    state. When you close the browser, the recording is saved. This is useful for
    recording login flows that can be replayed later.

    The recording consists of two files:

    - {name}.har: Network traffic (HTTP Archive format)

    - {name}.state.json: Browser state (cookies, localStorage, etc.)
    """
    _record(
        url=url,
        output_directory=output,
        recording_name=name,
        max_media_size=max_media_size,
    )


if __name__ == "__main__":
    typer.run(main)
