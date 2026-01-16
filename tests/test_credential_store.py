"""Tests for the credential store."""

import json
from pathlib import Path

from latchkey.credential_store import CredentialStore
from latchkey.credentials import AuthorizationBearer
from latchkey.services.slack import SlackCredentials


def test_save_and_get_authorization_bearer(tmp_path: Path) -> None:
    store_path = tmp_path / "credentials.json"
    store = CredentialStore(path=store_path)

    credentials = AuthorizationBearer(token="test-token")
    store.save("discord", credentials)

    loaded = store.get("discord")
    assert loaded == credentials
    assert isinstance(loaded, AuthorizationBearer)


def test_save_and_get_slack_credentials(tmp_path: Path) -> None:
    store_path = tmp_path / "credentials.json"
    store = CredentialStore(path=store_path)

    credentials = SlackCredentials(token="xoxc-token", d_cookie="d-cookie-value")
    store.save("slack", credentials)

    loaded = store.get("slack")
    assert loaded == credentials
    assert isinstance(loaded, SlackCredentials)


def test_get_returns_none_for_missing_service(tmp_path: Path) -> None:
    store_path = tmp_path / "credentials.json"
    store = CredentialStore(path=store_path)

    assert store.get("nonexistent") is None


def test_get_returns_none_for_nonexistent_file(tmp_path: Path) -> None:
    store_path = tmp_path / "does_not_exist.json"
    store = CredentialStore(path=store_path)

    assert store.get("any_service") is None


def test_save_creates_parent_directories(tmp_path: Path) -> None:
    store_path = tmp_path / "nested" / "dir" / "credentials.json"
    store = CredentialStore(path=store_path)

    credentials = AuthorizationBearer(token="test-token")
    store.save("discord", credentials)

    assert store_path.exists()
    assert store.get("discord") == credentials


def test_save_overwrites_existing_credentials(tmp_path: Path) -> None:
    store_path = tmp_path / "credentials.json"
    store = CredentialStore(path=store_path)

    original = AuthorizationBearer(token="original-token")
    store.save("discord", original)

    updated = AuthorizationBearer(token="updated-token")
    store.save("discord", updated)

    loaded = store.get("discord")
    assert loaded == updated


def test_save_preserves_other_services(tmp_path: Path) -> None:
    store_path = tmp_path / "credentials.json"
    store = CredentialStore(path=store_path)

    discord_creds = AuthorizationBearer(token="discord-token")
    slack_creds = SlackCredentials(token="slack-token", d_cookie="cookie")

    store.save("discord", discord_creds)
    store.save("slack", slack_creds)

    assert store.get("discord") == discord_creds
    assert store.get("slack") == slack_creds


def test_credentials_stored_as_json_with_type_discriminator(tmp_path: Path) -> None:
    store_path = tmp_path / "credentials.json"
    store = CredentialStore(path=store_path)

    credentials = SlackCredentials(token="xoxc-token", d_cookie="d-cookie")
    store.save("slack", credentials)

    raw_data = json.loads(store_path.read_text())
    assert raw_data["slack"]["object_type"] == "slack"
    assert raw_data["slack"]["token"] == "xoxc-token"
    assert raw_data["slack"]["d_cookie"] == "d-cookie"
