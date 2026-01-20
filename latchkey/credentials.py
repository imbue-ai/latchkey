from abc import ABC
from abc import abstractmethod
from enum import StrEnum

from pydantic import BaseModel
from pydantic import ConfigDict


class CredentialStatus(StrEnum):
    MISSING = "missing"
    VALID = "valid"
    INVALID = "invalid"


class Credentials(BaseModel, ABC):
    model_config = ConfigDict(frozen=True)

    object_type: str

    @abstractmethod
    def as_curl_arguments(self) -> tuple[str, ...]:
        """Return curl command-line arguments for authentication."""
        ...


class AuthorizationBearer(Credentials):
    object_type: str = "authorization_bearer"
    token: str

    def as_curl_arguments(self) -> tuple[str, ...]:
        return ("-H", f"Authorization: Bearer {self.token}")


class AuthorizationBare(Credentials):
    object_type: str = "authorization_bare"
    token: str

    def as_curl_arguments(self) -> tuple[str, ...]:
        return ("-H", f"Authorization: {self.token}")
