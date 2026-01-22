from pydantic import BaseModel
from pydantic import ConfigDict

from latchkey.services import DISCORD
from latchkey.services import DROPBOX
from latchkey.services import SLACK
from latchkey.services import Service
from latchkey.services.github import GITHUB


class Registry(BaseModel):
    model_config = ConfigDict(frozen=True)

    services: tuple[Service, ...] = ()

    def get_by_name(self, name: str) -> Service | None:
        for service in self.services:
            if service.name == name:
                return service
        return None

    def get_by_url(self, url: str) -> Service | None:
        for service in self.services:
            for base_api_url in service.base_api_urls:
                if url.startswith(base_api_url):
                    return service
        return None


REGISTRY = Registry(services=(SLACK, DISCORD, DROPBOX, GITHUB))
