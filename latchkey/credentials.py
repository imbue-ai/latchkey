from abc import ABC
from abc import abstractmethod

from pydantic import BaseModel
from pydantic import ConfigDict


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
