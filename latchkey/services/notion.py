"""
TODO: This is still WIP.

"""

from playwright.sync_api import Response

from latchkey import curl
from latchkey.api_credentials import ApiCredentialStatus
from latchkey.api_credentials import ApiCredentials
from latchkey.services.base import Service
from latchkey.services.base import ServiceSession


class NotionApiCredentials(ApiCredentials):
    object_type: str = "notion"
    token: str

    def as_curl_arguments(self) -> tuple[str, ...]:
        return (
            "-H",
            f"Authorization: Bearer {self.token}",
            "-H",
            "Notion-Version: 2022-06-28",
        )


class NotionServiceSession(ServiceSession):
    def _get_api_credentials_from_response(self, response: Response) -> ApiCredentials | None:
        request = response.request
        url = request.url
        if not url.startswith("https://www.notion.so/api/") and not url.startswith("https://api.notion.com/"):
            return None

        headers = request.headers
        authorization = headers.get("authorization")
        if authorization is not None and authorization.strip() != "":
            token = authorization
            if token.lower().startswith("bearer "):
                token = token[7:]
            return NotionApiCredentials(token=token)

        return None


class Notion(Service):
    name: str = "notion"
    base_api_urls: tuple[str, ...] = ("https://api.notion.com/",)
    login_url: str = "https://www.notion.so/login"

    @property
    def login_instructions(self) -> tuple[str, ...]:
        return (
            "Log in to your Notion account.",
            "After logging in, the token will be captured automatically.",
        )

    def get_session(self) -> NotionServiceSession:
        return NotionServiceSession(service=self)

    def check_api_credentials(self, api_credentials: ApiCredentials) -> ApiCredentialStatus:
        if not isinstance(api_credentials, NotionApiCredentials):
            return ApiCredentialStatus.INVALID

        result = curl.run_captured(
            [
                "-s",
                "-o",
                "/dev/null",
                "-w",
                "%{http_code}",
                *api_credentials.as_curl_arguments(),
                "https://api.notion.com/v1/users/me",
            ],
            timeout=10,
        )

        if result.stdout == "200":
            return ApiCredentialStatus.VALID
        return ApiCredentialStatus.INVALID


NOTION = Notion()
