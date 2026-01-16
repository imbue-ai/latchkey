Login Recording Test Directory
==============================

This directory contains recorded login sessions used for testing that service
implementations can properly detect completed logins and extract credentials.


STRUCTURE
---------

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


HOW TO CREATE A RECORDING
-------------------------

Use the record_login.py script to create a recording for a service:

    uv run dev/record_login.py <login_url> -o dev/recordings/<service_name> -n recording

For example, to record a Slack login:

    uv run dev/record_login.py https://slack.com/signin -o dev/recordings/slack -n recording

This will:
1. Open a browser at the login URL
2. Record all network traffic and browser state
3. When you close the browser, save:
   - recording.har: Network traffic (HTTP Archive format)
   - recording.state.json: Browser state (cookies, localStorage, etc.)


RUNNING THE TESTS
-----------------

To run all tests including recording tests:

    uv run pytest

To run only recording tests:

    uv run pytest dev/test_recordings.py

To test a specific service:

    uv run pytest dev/test_recordings.py -k slack

Verbose output:

    uv run pytest dev/test_recordings.py -v


HOW THE TESTS WORK
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


IMPORTANT NOTES
---------------

1. Recordings are .gitignored because:
   - They can be large (HAR files can contain many network requests)
   - They contain sensitive data (credentials, tokens, cookies)

2. Each recording directory should contain:
   - recording.har: Required for replaying network traffic
   - recording.state.json: Required for restoring browser state (cookies, localStorage)

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
