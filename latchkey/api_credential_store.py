"""API credential store for persisting and loading API credentials."""

import json
from pathlib import Path
from typing import Annotated
from typing import Any

from pydantic import BaseModel
from pydantic import ConfigDict
from pydantic import Discriminator
from pydantic import Tag
from pydantic import TypeAdapter

from latchkey.api_credentials import ApiCredentials
from latchkey.api_credentials import AuthorizationBare
from latchkey.api_credentials import AuthorizationBearer
from latchkey.services.notion import NotionApiCredentials
from latchkey.services.slack import SlackApiCredentials


def _get_api_credential_type(value: dict[str, object] | object) -> str:
    if isinstance(value, dict):
        return str(value.get("object_type", ""))
    return getattr(value, "object_type", "")


ApiCredentialType = Annotated[
    Annotated[AuthorizationBearer, Tag("authorization_bearer")]
    | Annotated[AuthorizationBare, Tag("authorization_bare")]
    | Annotated[NotionApiCredentials, Tag("notion")]
    | Annotated[SlackApiCredentials, Tag("slack")],
    Discriminator(_get_api_credential_type),
]

_api_credential_type_adapter: TypeAdapter[ApiCredentialType] = TypeAdapter(ApiCredentialType)


class ApiCredentialStoreError(Exception):
    pass


class ApiCredentialStore(BaseModel):
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

    def get(self, service_name: str) -> ApiCredentials | None:
        data = self._load_store_data()
        if service_name not in data:
            return None

        api_credential_data = data[service_name]
        return _api_credential_type_adapter.validate_python(api_credential_data)

    def save(self, service_name: str, api_credentials: ApiCredentials) -> None:
        data = self._load_store_data()
        data[service_name] = api_credentials.model_dump()
        self._save_store_data(data)

    def delete(self, service_name: str) -> bool:
        """Delete API credentials for a service. Returns True if credentials were deleted, False if not found."""
        data = self._load_store_data()
        if service_name not in data:
            return False
        del data[service_name]
        self._save_store_data(data)
        return True
