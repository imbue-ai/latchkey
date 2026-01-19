from playwright.sync_api import Page
from playwright.sync_api import Request

from latchkey.credentials import AuthorizationBare
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
        if authorization is not None:
            self._captured_token = authorization

    def wait_for_login_completed(self, page: Page) -> None:
        # # Wait for navigation to the Discord app (channels page)
        # page.wait_for_function(
        #     """() => /^https:\\/\\/discord\\.com\\/(channels|app)/.test(window.location.href)""",
        #     timeout=0,
        # )

        # Wait until we've captured the token from a network request
        while self._captured_token is None:
            page.wait_for_timeout(100)

    def extract_credentials(self, page: Page) -> AuthorizationBare:
        if self._captured_token is None:
            raise CredentialExtractionError("Could not capture Discord token from network requests")

        return AuthorizationBare(token=self._captured_token)


DISCORD = Discord()
