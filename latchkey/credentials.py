from abc import ABC
from abc import abstractmethod

from pydantic import BaseModel
from pydantic import ConfigDict


class Credentials(BaseModel, ABC):
    model_config = ConfigDict(frozen=True)

    @abstractmethod
    def as_curl_arguments(self) -> tuple[str, ...]:
        """Return curl command-line arguments for authentication."""
        ...


class AuthorizationBearer(Credentials):
    token: str

    def as_curl_arguments(self) -> tuple[str, ...]:
        return ("-H", f"Authorization: Bearer {self.token}")
