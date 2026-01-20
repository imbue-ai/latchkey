from concurrent.futures import Future

from playwright.sync_api import Request

from latchkey import curl
from latchkey.credentials import AuthorizationBare
from latchkey.credentials import CredentialStatus
from latchkey.credentials import Credentials
from latchkey.services.base import Service


class Discord(Service):
    name: str = "discord"
    base_api_urls: tuple[str, ...] = ("https://discord.com/api/",)
    login_url: str = "https://discord.com/login"

    def on_request(self, request: Request, credentials_future: Future[Credentials]) -> None:
        if credentials_future.done():
            return

        url = request.url
        if not url.startswith("https://discord.com/api/"):
            return

        headers = request.headers
        authorization = headers.get("authorization")
        if authorization is not None and authorization.strip() != "":
            credentials_future.set_result(AuthorizationBare(token=authorization))

    def check_credentials(self, credentials: Credentials) -> CredentialStatus:
        if not isinstance(credentials, AuthorizationBare):
            return CredentialStatus.INVALID

        result = curl.run_captured(
            [
                "-s",
                "-o",
                "/dev/null",
                "-w",
                "%{http_code}",
                *credentials.as_curl_arguments(),
                "https://discord.com/api/v9/users/@me",
            ],
            timeout=10,
        )

        if result.stdout == "200":
            return CredentialStatus.VALID
        return CredentialStatus.INVALID


DISCORD = Discord()
