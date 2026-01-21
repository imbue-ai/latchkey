import re
import uuid

from playwright.sync_api import BrowserContext
from playwright.sync_api import Response
from pydantic import PrivateAttr

from latchkey import curl
from latchkey.api_credentials import ApiCredentialStatus
from latchkey.api_credentials import ApiCredentials
from latchkey.api_credentials import AuthorizationBearer
from latchkey.services.base import BrowserFollowupServiceSession
from latchkey.services.base import Service

DEFAULT_TIMEOUT_MS = 8000


class DropboxTokenGenerationError(Exception):
    pass


class DropboxServiceSession(BrowserFollowupServiceSession):
    _is_logged_in: bool = PrivateAttr(default=False)

    def on_response(self, response: Response) -> None:
        if self._is_logged_in:
            return

        request = response.request
        url = request.url

        # Check if this is a request to www.dropbox.com
        if not url.startswith("https://www.dropbox.com/"):
            return

        headers = request.all_headers()

        # Check for the x-dropbox-uid header which contains the user ID.
        # When logged out, this header is either absent or set to "-1".
        # When logged in, it contains the actual positive user ID.
        uid_header = headers.get("x-dropbox-uid")
        if uid_header is None:
            return

        # A value of "-1" indicates not logged in
        if uid_header == "-1":
            return

        self._is_logged_in = True

    def _is_headful_login_complete(self) -> bool:
        return self._is_logged_in

    def _perform_browser_followup(self, context: BrowserContext) -> ApiCredentials | None:
        page = context.new_page()

        # Step 1: Go to app creation page
        page.goto("https://www.dropbox.com/developers/apps/create")

        # Step 2: Wait for and select "Scoped access"
        scoped_input = page.locator("input#scoped")
        scoped_input.wait_for(timeout=DEFAULT_TIMEOUT_MS)
        scoped_input.click()

        # Step 3: Wait for and select "Full Dropbox" access
        full_permissions_input = page.locator("input#full_permissions")
        full_permissions_input.wait_for(timeout=DEFAULT_TIMEOUT_MS)
        full_permissions_input.click()

        # Step 4: Wait for and fill the app name input
        app_name = f"Latchkey-{uuid.uuid4().hex[:8]}"
        app_name_input = page.locator("input#app-name")
        app_name_input.wait_for(timeout=DEFAULT_TIMEOUT_MS)
        app_name_input.fill(app_name)

        # Step 5: Wait for and click the "Create app" button
        create_button = page.get_by_role("button", name="Create app")
        create_button.wait_for(timeout=DEFAULT_TIMEOUT_MS)
        create_button.click()

        # Step 6: Wait for navigation to the app info page
        page.wait_for_url(re.compile(r"https://www\.dropbox\.com/developers/apps/info/"), timeout=DEFAULT_TIMEOUT_MS)

        # Step 7: Wait for and click the "Generate" button to create an access token
        generate_button = page.locator("input#generate-token-button")
        generate_button.wait_for(timeout=DEFAULT_TIMEOUT_MS)
        generate_button.click()

        # Step 8: Wait for the token to appear and retrieve it
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
