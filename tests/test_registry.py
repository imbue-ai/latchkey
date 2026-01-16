"""Tests for the service registry."""

from typing import Callable
from unittest.mock import MagicMock

import pytest

from latchkey.registry import Registry
from latchkey.services import Service


@pytest.fixture
def mock_service() -> MagicMock:
    service = MagicMock(spec=Service)
    service.base_api_urls = ("https://api.example.com",)
    return service


@pytest.fixture
def create_registry() -> Callable[[tuple[Service, ...]], Registry]:
    """Factory fixture that creates a Registry instance with the given services."""

    def _create_registry(services: tuple[Service, ...]) -> Registry:
        return Registry(services=services)

    return _create_registry


class TestRegistry:
    def test_get_from_url_returns_none_when_no_services(self) -> None:
        """get_from_url returns None when there are no registered services."""
        registry = Registry()
        result = registry.get_from_url("https://api.example.com/v1/users")
        assert result is None

    def test_get_from_url_returns_matching_service(
        self,
        mock_service: MagicMock,
        create_registry: Callable[[tuple[Service, ...]], Registry],
    ) -> None:
        """get_from_url returns the service whose base_api_url matches the URL prefix."""
        registry = create_registry((mock_service,))

        result = registry.get_from_url("https://api.example.com/v1/users")
        assert result is mock_service

    def test_get_from_url_returns_none_when_no_match(
        self,
        mock_service: MagicMock,
        create_registry: Callable[[tuple[Service, ...]], Registry],
    ) -> None:
        """get_from_url returns None when no service matches the URL."""
        registry = create_registry((mock_service,))

        result = registry.get_from_url("https://other.example.com/v1/users")
        assert result is None

    def test_get_from_url_returns_first_matching_service(
        self,
        create_registry: Callable[[tuple[Service, ...]], Registry],
    ) -> None:
        """get_from_url returns the first service that matches when multiple could match."""
        mock_service_1 = MagicMock(spec=Service)
        mock_service_1.base_api_urls = ("https://api.example.com",)

        mock_service_2 = MagicMock(spec=Service)
        mock_service_2.base_api_urls = ("https://api.example.com/v2",)

        registry = create_registry((mock_service_1, mock_service_2))

        result = registry.get_from_url("https://api.example.com/v2/users")
        assert result is mock_service_1

    def test_get_from_url_matches_any_of_multiple_base_urls(
        self,
        create_registry: Callable[[tuple[Service, ...]], Registry],
    ) -> None:
        """get_from_url matches a service if the URL matches any of its base_api_urls."""
        mock_service = MagicMock(spec=Service)
        mock_service.base_api_urls = (
            "https://api.example.com",
            "https://api-v2.example.com",
        )

        registry = create_registry((mock_service,))

        result_1 = registry.get_from_url("https://api.example.com/users")
        result_2 = registry.get_from_url("https://api-v2.example.com/users")
        result_3 = registry.get_from_url("https://other.example.com/users")

        assert result_1 is mock_service
        assert result_2 is mock_service
        assert result_3 is None

    def test_services_is_empty_tuple_by_default(self) -> None:
        """The services attribute is an empty tuple by default."""
        registry = Registry()
        assert registry.services == ()

    def test_registry_is_frozen(self, mock_service: MagicMock) -> None:
        """Registry instances are immutable."""
        registry = Registry()
        with pytest.raises(Exception):  # pydantic raises ValidationError for frozen models
            registry.services = (mock_service,)  # type: ignore[misc]
