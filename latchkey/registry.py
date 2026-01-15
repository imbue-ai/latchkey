"""Service registry for looking up services by URL."""

from pydantic import BaseModel

from latchkey.services import Service


class Registry(BaseModel, frozen=True):
    """Registry of supported services."""

    services: tuple[Service, ...] = ()

    def get_from_url(self, url: str) -> Service | None:
        """
        Get a service instance that matches the given URL.

        Args:
            url: The URL to match against registered services.

        Returns:
            A Service instance if one matches the URL, None otherwise.
        """
        for service in self.services:
            if url.startswith(service.base_api_url):
                return service
        return None


REGISTRY = Registry()
