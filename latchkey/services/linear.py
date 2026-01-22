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

# URL for creating a new personal API key (also used as login URL)
LINEAR_NEW_API_KEY_URL = "https://linear.app/imbue/settings/account/security/api-keys/new"


class LinearServiceSession(BrowserFollowupServiceSession):
    _is_logged_in: bool = PrivateAttr(default=False)

    def on_response(self, response: Response) -> None:
        if self._is_logged_in:
            return

        request = response.request
        url = request.url
        if not url.startswith("https://linear.app/"):
            return

        # Detect login by checking for authenticated API requests
        headers = request.all_headers()
        # Linear sets authentication cookies after successful login
        cookies = headers.get("cookie", "")
        if "linear-session" in cookies or "linear_session" in cookies:
            self._is_logged_in = True

    def _is_headful_login_complete(self) -> bool:
        return self._is_logged_in

    def _perform_browser_followup(self, context: BrowserContext) -> ApiCredentials | None:
        page = context.new_page()

        page.goto(LINEAR_NEW_API_KEY_URL)

        # Fill in the key name
        key_name = f"Latchkey-{uuid.uuid4().hex[:8]}"
        key_name_input = page.get_by_role("textbox", name="Key name")
        key_name_input.wait_for(timeout=DEFAULT_TIMEOUT_MS)
        type_like_human(page, key_name_input, key_name)

        # Click the Create button
        create_button = page.get_by_role("button", name="Create")
        create_button.wait_for(timeout=DEFAULT_TIMEOUT_MS)
        create_button.click()

        # Wait for and extract the token from span element containing lin_api_ prefix
        token_element = page.locator("span:text-matches('^lin_api_')")
        token_element.wait_for(timeout=DEFAULT_TIMEOUT_MS)

        token = token_element.text_content()
        if token is None or token == "":
            raise LoginFailedError("Failed to extract token from Linear.")

        page.close()

        return AuthorizationBearer(token=token)


class Linear(Service):
    name: str = "linear"
    base_api_urls: tuple[str, ...] = ("https://api.linear.app/",)
    login_url: str = LINEAR_NEW_API_KEY_URL

    def get_session(self) -> LinearServiceSession:
        return LinearServiceSession(service=self)

    @property
    def credential_check_curl_arguments(self) -> tuple[str, ...]:
        return (
            "-X",
            "POST",
            "-H",
            "Content-Type: application/json",
            "-d",
            '{"query": "{ viewer { id } }"}',
            "https://api.linear.app/graphql",
        )

    def check_api_credentials(self, api_credentials: ApiCredentials) -> ApiCredentialStatus:
        if not isinstance(api_credentials, AuthorizationBearer):
            return ApiCredentialStatus.INVALID

        # Linear uses GraphQL API - check credentials with a simple query
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


LINEAR = Linear()
