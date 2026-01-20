"""Browser state management utilities."""

import os
from pathlib import Path

LATCHKEY_BROWSER_STATE_ENV_VAR = "LATCHKEY_BROWSER_STATE"


def get_browser_state_path() -> Path | None:
    """Get the browser state path from the LATCHKEY_BROWSER_STATE environment variable."""
    env_value = os.environ.get(LATCHKEY_BROWSER_STATE_ENV_VAR)
    if env_value:
        return Path(env_value).expanduser()
    return None
