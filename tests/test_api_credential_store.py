"""Tests for the API credential store."""

import json
from pathlib import Path

from latchkey.api_credential_store import ApiCredentialStore
from latchkey.api_credentials import AuthorizationBearer
from latchkey.services.slack import SlackApiCredentials


def test_save_and_get_authorization_bearer(tmp_path: Path) -> None:
    store_path = tmp_path / "api_credentials.json"
    store = ApiCredentialStore(path=store_path)

    api_credentials = AuthorizationBearer(token="test-token")
    store.save("discord", api_credentials)

    loaded = store.get("discord")
    assert loaded == api_credentials
    assert isinstance(loaded, AuthorizationBearer)


def test_save_and_get_slack_api_credentials(tmp_path: Path) -> None:
    store_path = tmp_path / "api_credentials.json"
    store = ApiCredentialStore(path=store_path)

    api_credentials = SlackApiCredentials(token="xoxc-token", d_cookie="d-cookie-value")
    store.save("slack", api_credentials)

    loaded = store.get("slack")
    assert loaded == api_credentials
    assert isinstance(loaded, SlackApiCredentials)


def test_get_returns_none_for_missing_service(tmp_path: Path) -> None:
    store_path = tmp_path / "api_credentials.json"
    store = ApiCredentialStore(path=store_path)

    assert store.get("nonexistent") is None


def test_get_returns_none_for_nonexistent_file(tmp_path: Path) -> None:
    store_path = tmp_path / "does_not_exist.json"
    store = ApiCredentialStore(path=store_path)

    assert store.get("any_service") is None


def test_save_creates_parent_directories(tmp_path: Path) -> None:
    store_path = tmp_path / "nested" / "dir" / "api_credentials.json"
    store = ApiCredentialStore(path=store_path)

    api_credentials = AuthorizationBearer(token="test-token")
    store.save("discord", api_credentials)

    assert store_path.exists()
    assert store.get("discord") == api_credentials


def test_save_overwrites_existing_api_credentials(tmp_path: Path) -> None:
    store_path = tmp_path / "api_credentials.json"
    store = ApiCredentialStore(path=store_path)

    original = AuthorizationBearer(token="original-token")
    store.save("discord", original)

    updated = AuthorizationBearer(token="updated-token")
    store.save("discord", updated)

    loaded = store.get("discord")
    assert loaded == updated


def test_save_preserves_other_services(tmp_path: Path) -> None:
    store_path = tmp_path / "api_credentials.json"
    store = ApiCredentialStore(path=store_path)

    discord_creds = AuthorizationBearer(token="discord-token")
    slack_creds = SlackApiCredentials(token="slack-token", d_cookie="cookie")

    store.save("discord", discord_creds)
    store.save("slack", slack_creds)

    assert store.get("discord") == discord_creds
    assert store.get("slack") == slack_creds


def test_api_credentials_stored_as_json_with_type_discriminator(tmp_path: Path) -> None:
    store_path = tmp_path / "api_credentials.json"
    store = ApiCredentialStore(path=store_path)

    api_credentials = SlackApiCredentials(token="xoxc-token", d_cookie="d-cookie")
    store.save("slack", api_credentials)

    raw_data = json.loads(store_path.read_text())
    assert raw_data["slack"]["object_type"] == "slack"
    assert raw_data["slack"]["token"] == "xoxc-token"
    assert raw_data["slack"]["d_cookie"] == "d-cookie"


def test_delete_removes_api_credentials(tmp_path: Path) -> None:
    store_path = tmp_path / "api_credentials.json"
    store = ApiCredentialStore(path=store_path)

    api_credentials = AuthorizationBearer(token="test-token")
    store.save("discord", api_credentials)

    result = store.delete("discord")

    assert result is True
    assert store.get("discord") is None


def test_delete_returns_false_for_missing_service(tmp_path: Path) -> None:
    store_path = tmp_path / "api_credentials.json"
    store = ApiCredentialStore(path=store_path)

    result = store.delete("nonexistent")

    assert result is False


def test_delete_returns_false_for_nonexistent_file(tmp_path: Path) -> None:
    store_path = tmp_path / "does_not_exist.json"
    store = ApiCredentialStore(path=store_path)

    result = store.delete("any_service")

    assert result is False


def test_delete_preserves_other_services(tmp_path: Path) -> None:
    store_path = tmp_path / "api_credentials.json"
    store = ApiCredentialStore(path=store_path)

    discord_creds = AuthorizationBearer(token="discord-token")
    slack_creds = SlackApiCredentials(token="slack-token", d_cookie="cookie")

    store.save("discord", discord_creds)
    store.save("slack", slack_creds)

    store.delete("discord")

    assert store.get("discord") is None
    assert store.get("slack") == slack_creds
