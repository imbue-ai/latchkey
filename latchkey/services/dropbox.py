import random
import re
import uuid

from playwright.sync_api import BrowserContext
from playwright.sync_api import Locator
from playwright.sync_api import Page
from playwright.sync_api import Response
from pydantic import PrivateAttr

from latchkey import curl
from latchkey.api_credentials import ApiCredentialStatus
from latchkey.api_credentials import ApiCredentials
from latchkey.api_credentials import AuthorizationBearer
from latchkey.services.base import BrowserFollowupServiceSession
from latchkey.services.base import Service

DEFAULT_TIMEOUT_MS = 8000

# Typing delay range in milliseconds (min, max) to simulate human-like typing
TYPING_DELAY_MIN_MS = 30
TYPING_DELAY_MAX_MS = 100


def type_like_human(page: Page, locator: Locator, text: str) -> None:
    """Type text character by character with random delays to simulate human typing.

    This triggers proper JavaScript input events that some websites require,
    unlike fill() which sets the value directly.
    """
    locator.click()
    for character in text:
        locator.press_sequentially(character)
        delay = random.randint(TYPING_DELAY_MIN_MS, TYPING_DELAY_MAX_MS)
        page.wait_for_timeout(delay)


class DropboxTokenGenerationError(Exception):
    pass


class DropboxServiceSession(BrowserFollowupServiceSession):
    _is_logged_in: bool = PrivateAttr(default=False)

    def on_response(self, response: Response) -> None:
        if self._is_logged_in:
            return

        request = response.request
        url = request.url
        if not url.startswith("https://www.dropbox.com/"):
            return

        headers = request.all_headers()
        uid_header = headers.get("x-dropbox-uid")
        if uid_header is None or uid_header == "-1":
            return

        self._is_logged_in = True

    def _is_headful_login_complete(self) -> bool:
        return self._is_logged_in

    def _perform_browser_followup(self, context: BrowserContext) -> ApiCredentials | None:
        page = context.new_page()

        page.goto("https://www.dropbox.com/developers/apps/create")

        scoped_input = page.locator("input#scoped")
        scoped_input.wait_for(timeout=DEFAULT_TIMEOUT_MS)
        scoped_input.click()

        full_permissions_input = page.locator("input#full_permissions")
        full_permissions_input.wait_for(timeout=DEFAULT_TIMEOUT_MS)
        full_permissions_input.click()

        app_name = f"Latchkey-{uuid.uuid4().hex[:8]}"
        app_name_input = page.locator("input#app-name")
        app_name_input.wait_for(timeout=DEFAULT_TIMEOUT_MS)
        type_like_human(page, app_name_input, app_name)

        create_button = page.get_by_role("button", name="Create app")
        create_button.wait_for(timeout=DEFAULT_TIMEOUT_MS)
        create_button.click()

        page.wait_for_url(re.compile(r"https://www\.dropbox\.com/developers/apps/info/"), timeout=DEFAULT_TIMEOUT_MS)

        generate_button = page.locator("input#generate-token-button")
        generate_button.wait_for(timeout=DEFAULT_TIMEOUT_MS)
        generate_button.click()

        token_input = page.locator("input#generated-token[data-token]")
        token_input.wait_for(timeout=DEFAULT_TIMEOUT_MS)

        token = token_input.get_attribute("data-token")
        if token is None or token == "":
            raise DropboxTokenGenerationError("Failed to extract token from data-token attribute")

        page.close()

        return AuthorizationBearer(token=token)


class Dropbox(Service):
    name: str = "dropbox"
    base_api_urls: tuple[str, ...] = ("https://api.dropboxapi.com/",)
    login_url: str = "https://www.dropbox.com/login"

    def get_session(self) -> DropboxServiceSession:
        return DropboxServiceSession(service=self)

    def check_api_credentials(self, api_credentials: ApiCredentials) -> ApiCredentialStatus:
        if not isinstance(api_credentials, AuthorizationBearer):
            return ApiCredentialStatus.INVALID

        result = curl.run_captured(
            [
                "-s",
                "-o",
                "/dev/null",
                "-w",
                "%{http_code}",
                "-X",
                "POST",
                *api_credentials.as_curl_arguments(),
                "https://api.dropboxapi.com/2/users/get_current_account",
            ],
            timeout=10,
        )

        if result.stdout == "200":
            return ApiCredentialStatus.VALID
        return ApiCredentialStatus.INVALID


DROPBOX = Dropbox()
