from playwright.sync_api import BrowserContext
from playwright.sync_api import Response
from pydantic import PrivateAttr

from latchkey import curl
from latchkey.api_credentials import ApiCredentialStatus
from latchkey.api_credentials import ApiCredentials
from latchkey.api_credentials import AuthorizationBearer
from latchkey.services.base import BrowserFollowupServiceSession
from latchkey.services.base import Service


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
        # TODO: Implement browser automation to create a personal API key
        # This will navigate to https://linear.app/settings/api and
        # create a new personal API key
        return None


class Linear(Service):
    name: str = "linear"
    base_api_urls: tuple[str, ...] = ("https://api.linear.app/",)
    login_url: str = "https://linear.app/login"

    def get_session(self) -> LinearServiceSession:
        return LinearServiceSession(service=self)

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
                "-X",
                "POST",
                "-H",
                "Content-Type: application/json",
                *api_credentials.as_curl_arguments(),
                "-d",
                '{"query": "{ viewer { id } }"}',
                "https://api.linear.app/graphql",
            ],
            timeout=10,
        )

        if result.stdout == "200":
            return ApiCredentialStatus.VALID
        return ApiCredentialStatus.INVALID


LINEAR = Linear()
