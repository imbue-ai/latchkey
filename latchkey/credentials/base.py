from abc import ABC
from abc import abstractmethod

from pydantic import BaseModel
from pydantic import ConfigDict


class Credentials(BaseModel, ABC):
    model_config = ConfigDict(frozen=True)
    """Abstract base class for service credentials."""

    @abstractmethod
    def as_curl_arguments(self) -> tuple[str, ...]:
        """Return curl command-line arguments for authentication."""
        ...
