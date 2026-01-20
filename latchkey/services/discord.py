import urllib.error
import urllib.request

from playwright.sync_api import Page
from playwright.sync_api import Request

from latchkey.credentials import AuthorizationBare
from latchkey.credentials import CredentialStatus
from latchkey.credentials import Credentials
from latchkey.services.base import CredentialExtractionError
from latchkey.services.base import Service


class Discord(Service):
    name: str = "discord"
    base_api_urls: tuple[str, ...] = ("https://discord.com/api/",)
    login_url: str = "https://discord.com/login"

    _captured_token: str | None = None

    def on_request(self, request: Request) -> None:
        if self._captured_token is not None:
            return

        url = request.url
        if not url.startswith("https://discord.com/api/"):
            return

        headers = request.headers
        authorization = headers.get("authorization")
        if authorization is not None and authorization.strip() != "":
            self._captured_token = authorization

    def wait_for_login_completed(self, page: Page) -> None:
        # Wait until we've captured the token from a network request
        while self._captured_token is None:
            page.wait_for_timeout(100)

    def extract_credentials(self, page: Page) -> AuthorizationBare:
        if self._captured_token is None:
            raise CredentialExtractionError("Could not capture Discord token from network requests")

        return AuthorizationBare(token=self._captured_token)

    def check_credentials(self, credentials: Credentials) -> CredentialStatus:
        if not isinstance(credentials, AuthorizationBare):
            return CredentialStatus.INVALID

        request = urllib.request.Request(
            "https://discord.com/api/v9/users/@me",
            headers={
                "Authorization": credentials.token,
                "User-Agent": "curl/8.14.1",
            },
        )

        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                if response.status == 200:
                    return CredentialStatus.VALID
                return CredentialStatus.INVALID
        except urllib.error.HTTPError:
            return CredentialStatus.INVALID
        except urllib.error.URLError:
            return CredentialStatus.INVALID


DISCORD = Discord()
