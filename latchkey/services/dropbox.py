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
from latchkey.services.base import LoginFailedError
from latchkey.services.base import Service
from latchkey.services.playwright_utils import type_like_human

DEFAULT_TIMEOUT_MS = 8000


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

        # Configure permissions before generating token
        permissions_tab = page.locator('a.c-tabs__label[data-hash="permissions"]')
        permissions_tab.wait_for(timeout=DEFAULT_TIMEOUT_MS)
        permissions_tab.click()

        # Enable all necessary permissions
        permission_ids = [
            "files.metadata.write",
            "files.content.write",
            "files.content.read",
            "sharing.write",
            "file_requests.write",
            "contacts.write",
        ]
        for permission_id in permission_ids:
            escaped_permission_id = permission_id.replace(".", r"\.")
            checkbox = page.locator(f"input#{escaped_permission_id}")
            checkbox.wait_for(timeout=DEFAULT_TIMEOUT_MS)
            checkbox.click()

        # Submit permissions
        submit_button = page.locator("button.permissions-submit-button")
        submit_button.wait_for(timeout=DEFAULT_TIMEOUT_MS)
        submit_button.click()

        # Wait for permissions to be saved
        page.wait_for_timeout(512)

        # Return to Settings tab to generate token
        settings_tab = page.locator('a.c-tabs__label[data-hash="settings"]')
        settings_tab.wait_for(timeout=DEFAULT_TIMEOUT_MS)
        settings_tab.click()

        generate_button = page.locator("input#generate-token-button")
        generate_button.wait_for(timeout=DEFAULT_TIMEOUT_MS)
        generate_button.click()

        token_input = page.locator("input#generated-token[data-token]")
        token_input.wait_for(timeout=DEFAULT_TIMEOUT_MS)

        token = token_input.get_attribute("data-token")
        if token is None or token == "":
            raise LoginFailedError("Failed to extract token from Dropbox.")

        page.close()

        return AuthorizationBearer(token=token)


class Dropbox(Service):
    name: str = "dropbox"
    base_api_urls: tuple[str, ...] = (
        "https://api.dropboxapi.com/",
        "https://content.dropboxapi.com/",
        "https://notify.dropboxapi.com/",
    )
    login_url: str = "https://www.dropbox.com/login"

    def get_session(self) -> DropboxServiceSession:
        return DropboxServiceSession(service=self)

    @property
    def credential_check_curl_arguments(self) -> tuple[str, ...]:
        return (
            "-X",
            "POST",
            "https://api.dropboxapi.com/2/users/get_current_account",
        )

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
                *api_credentials.as_curl_arguments(),
                *self.credential_check_curl_arguments,
            ],
            timeout=10,
        )

        if result.stdout == "200":
            return ApiCredentialStatus.VALID
        return ApiCredentialStatus.INVALID


DROPBOX = Dropbox()
