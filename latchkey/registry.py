from pydantic import BaseModel
from pydantic import ConfigDict

from latchkey.services import SLACK
from latchkey.services import Service


class Registry(BaseModel):
    model_config = ConfigDict(frozen=True)

    services: tuple[Service, ...] = ()

    def get_from_url(self, url: str) -> Service | None:
        for service in self.services:
            for base_api_url in service.base_api_urls:
                if url.startswith(base_api_url):
                    return service
        return None


REGISTRY = Registry(services=(SLACK,))
