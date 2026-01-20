"""Credential store for persisting and loading credentials."""

import json
from pathlib import Path
from typing import Annotated
from typing import Any

from pydantic import BaseModel
from pydantic import ConfigDict
from pydantic import Discriminator
from pydantic import Tag
from pydantic import TypeAdapter

from latchkey.credentials import AuthorizationBare
from latchkey.credentials import AuthorizationBearer
from latchkey.credentials import Credentials
from latchkey.services.notion import NotionCredentials
from latchkey.services.slack import SlackCredentials


def _get_credential_type(value: dict[str, object] | object) -> str:
    if isinstance(value, dict):
        return str(value.get("object_type", ""))
    return getattr(value, "object_type", "")


CredentialType = Annotated[
    Annotated[AuthorizationBearer, Tag("authorization_bearer")]
    | Annotated[AuthorizationBare, Tag("authorization_bare")]
    | Annotated[NotionCredentials, Tag("notion")]
    | Annotated[SlackCredentials, Tag("slack")],
    Discriminator(_get_credential_type),
]

_credential_type_adapter: TypeAdapter[CredentialType] = TypeAdapter(CredentialType)


class CredentialStoreError(Exception):
    pass


class CredentialStore(BaseModel):
    model_config = ConfigDict(frozen=True)

    path: Path

    def _load_store_data(self) -> dict[str, Any]:
        if not self.path.exists():
            return {}
        content = self.path.read_text()
        return json.loads(content)

    def _save_store_data(self, data: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(data, indent=2))

    def get(self, service_name: str) -> Credentials | None:
        data = self._load_store_data()
        if service_name not in data:
            return None

        credential_data = data[service_name]
        return _credential_type_adapter.validate_python(credential_data)

    def save(self, service_name: str, credentials: Credentials) -> None:
        data = self._load_store_data()
        data[service_name] = credentials.model_dump()
        self._save_store_data(data)

    def delete(self, service_name: str) -> bool:
        """Delete credentials for a service. Returns True if credentials were deleted, False if not found."""
        data = self._load_store_data()
        if service_name not in data:
            return False
        del data[service_name]
        self._save_store_data(data)
        return True
