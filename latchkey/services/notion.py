from concurrent.futures import Future

from playwright.sync_api import Request

from latchkey import curl
from latchkey.credentials import CredentialStatus
from latchkey.credentials import Credentials
from latchkey.services.base import Service


class NotionCredentials(Credentials):
    object_type: str = "notion"
    token: str

    def as_curl_arguments(self) -> tuple[str, ...]:
        return (
            "-H",
            f"Authorization: Bearer {self.token}",
            "-H",
            "Notion-Version: 2022-06-28",
        )


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

    def on_request(self, request: Request, credentials_future: Future[Credentials]) -> None:
        if credentials_future.done():
            return

        url = request.url
        if not url.startswith("https://www.notion.so/api/") and not url.startswith("https://api.notion.com/"):
            return

        headers = request.headers
        authorization = headers.get("authorization")
        if authorization is not None and authorization.strip() != "":
            token = authorization
            if token.lower().startswith("bearer "):
                token = token[7:]
            credentials_future.set_result(NotionCredentials(token=token))

    def check_credentials(self, credentials: Credentials) -> CredentialStatus:
        if not isinstance(credentials, NotionCredentials):
            return CredentialStatus.INVALID

        result = curl.run_captured(
            [
                "-s",
                "-o",
                "/dev/null",
                "-w",
                "%{http_code}",
                *credentials.as_curl_arguments(),
                "https://api.notion.com/v1/users/me",
            ],
            timeout=10,
        )

        if result.stdout == "200":
            return CredentialStatus.VALID
        return CredentialStatus.INVALID


NOTION = Notion()
