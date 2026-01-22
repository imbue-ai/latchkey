from playwright.sync_api import BrowserContext
from playwright.sync_api import Response
from pydantic import PrivateAttr

from latchkey import curl
from latchkey.api_credentials import ApiCredentialStatus
from latchkey.api_credentials import ApiCredentials
from latchkey.api_credentials import AuthorizationBearer
from latchkey.services.base import BrowserFollowupServiceSession
from latchkey.services.base import Service


class GithubServiceSession(BrowserFollowupServiceSession):
    _is_logged_in: bool = PrivateAttr(default=False)

    def on_response(self, response: Response) -> None:
        if self._is_logged_in:
            return

        request = response.request
        url = request.url
        if not url.startswith("https://github.com/"):
            return

        # Detect login by checking for logged-in user indicator in responses
        headers = request.all_headers()
        # GitHub sets a logged_in cookie after successful authentication
        cookies = headers.get("cookie", "")
        if "logged_in=yes" in cookies:
            self._is_logged_in = True

    def _is_headful_login_complete(self) -> bool:
        return self._is_logged_in

    def _perform_browser_followup(self, context: BrowserContext) -> ApiCredentials | None:
        # TODO: Implement browser automation to create a personal access token
        # This will navigate to https://github.com/settings/tokens/new and
        # create a new token with appropriate permissions
        return None


class Github(Service):
    name: str = "github"
    base_api_urls: tuple[str, ...] = ("https://api.github.com/",)
    login_url: str = "https://github.com/login"

    def get_session(self) -> GithubServiceSession:
        return GithubServiceSession(service=self)

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
                "https://api.github.com/user",
            ],
            timeout=10,
        )

        if result.stdout == "200":
            return ApiCredentialStatus.VALID
        return ApiCredentialStatus.INVALID


GITHUB = Github()
