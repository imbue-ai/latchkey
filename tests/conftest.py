"""Shared pytest fixtures for all tests."""

import pytest


@pytest.fixture(autouse=True)
def clear_latchkey_store_env(monkeypatch: pytest.MonkeyPatch):
    """Clear LATCHKEY_STORE env var to ensure tests don't depend on user's environment."""
    monkeypatch.delenv("LATCHKEY_STORE", raising=False)
