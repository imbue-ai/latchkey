"""Shared pytest fixtures for all tests."""

import pytest


@pytest.fixture(autouse=True)
def clear_latchkey_env_vars(monkeypatch: pytest.MonkeyPatch):
    """Clear LATCHKEY_* env vars to ensure tests don't depend on user's environment."""
    monkeypatch.delenv("LATCHKEY_STORE", raising=False)
    monkeypatch.delenv("LATCHKEY_BROWSER_STATE", raising=False)
