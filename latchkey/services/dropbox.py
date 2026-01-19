from playwright.sync_api import Page
from playwright.sync_api import Request

from latchkey.credentials import AuthorizationBearer
from latchkey.services.base import CredentialExtractionError
from latchkey.services.base import Service


class Dropbox(Service):
    name: str = "dropbox"
    base_api_urls: tuple[str, ...] = (
        "https://api.dropboxapi.com/",
        "https://content.dropboxapi.com/",
        "https://paper.dropboxapi.com/",
    )
    login_url: str = "https://www.dropbox.com/login"

    _captured_token: str | None = None

    @property
    def login_instructions(self) -> tuple[str, ...]:
        return (
            "(!) Accept all cookies if prompted.",
            "(!) Log in to your Dropbox account.",
            "(!) After logging in, navigate to any folder or file to complete the authentication.",
        )

    def on_request(self, request: Request) -> None:
        if self._captured_token is not None:
            return

        url = request.url
        if not url.startswith("https://www.dropbox.com/"):
            return

        headers = request.headers
        authorization = headers.get("authorization")
        if authorization is not None and authorization.startswith("Bearer "):
            self._captured_token = authorization.removeprefix("Bearer ")

    def wait_for_login_completed(self, page: Page) -> None:
        # Wait until we've captured the token from a network request
        while self._captured_token is None:
            page.wait_for_timeout(100)

    def extract_credentials(self, page: Page) -> AuthorizationBearer:
        if self._captured_token is None:
            raise CredentialExtractionError("Could not capture Dropbox token from network requests")

        return AuthorizationBearer(token=self._captured_token)


DROPBOX = Dropbox()
