from playwright.sync_api import BrowserContext
from playwright.sync_api import Response
from pydantic import PrivateAttr

from latchkey import curl
from latchkey.api_credentials import ApiCredentialStatus
from latchkey.api_credentials import ApiCredentials
from latchkey.api_credentials import AuthorizationBearer
from latchkey.playwright_utils import type_like_human
from latchkey.services.base import BrowserFollowupServiceSession
from latchkey.services.base import LoginFailedError
from latchkey.services.base import Service

DEFAULT_TIMEOUT_MS = 8000

# URL for creating a new personal access token (also used as login URL to trigger sudo)
GITHUB_NEW_TOKEN_URL = "https://github.com/settings/tokens/new"

# GitHub personal access token scopes to enable
GITHUB_TOKEN_SCOPES = [
    "repo",
    "workflow",
    "write:packages",
    "delete:packages",
    "gist",
    "notifications",
    "admin:org",
    "admin:repo_hook",
    "admin:org_hook",
    "user",
    "delete_repo",
    "write:discussion",
    "admin:enterprise",
    "read:audit_log",
    "codespace",
    "copilot",
    "write:network_configurations",
    "project",
]


class GithubServiceSession(BrowserFollowupServiceSession):
    _is_logged_in: bool = PrivateAttr(default=False)

    def on_response(self, response: Response) -> None:
        if self._is_logged_in:
            return

        request = response.request
        # Detect login (and github's sudo) by seeing if github allows us to access the new token page.
        if request.url == GITHUB_NEW_TOKEN_URL:
            if response.status == 200:
                self._is_logged_in = True

    def _is_headful_login_complete(self) -> bool:
        return self._is_logged_in

    def _perform_browser_followup(self, context: BrowserContext) -> ApiCredentials | None:
        page = context.new_page()

        page.goto(GITHUB_NEW_TOKEN_URL)

        # Add a note for the token
        note_input = page.locator('//*[@id="oauth_access_description"]')
        note_input.wait_for(timeout=DEFAULT_TIMEOUT_MS)
        type_like_human(page, note_input, "Latchkey")

        # Enable all necessary scopes
        for scope in GITHUB_TOKEN_SCOPES:
            checkbox = page.locator(f'input[name="oauth_access[scopes][]"][value="{scope}"]')
            if checkbox.is_visible():
                checkbox.check()

        # Click the Generate Token button
        generate_button = page.locator('button[type="submit"].btn-primary:has-text("Generate token")')
        generate_button.wait_for(timeout=DEFAULT_TIMEOUT_MS)
        generate_button.click()

        # Wait for the page to load and retrieve the generated token
        token_element = page.locator('//*[@id="new-oauth-token"]')
        token_element.wait_for(timeout=DEFAULT_TIMEOUT_MS)

        token = token_element.text_content()
        if token is None or token == "":
            raise LoginFailedError("Failed to extract token from GitHub.")

        page.close()

        return AuthorizationBearer(token=token)


class Github(Service):
    name: str = "github"
    base_api_urls: tuple[str, ...] = ("https://api.github.com/",)
    login_url: str = GITHUB_NEW_TOKEN_URL

    def get_session(self) -> GithubServiceSession:
        return GithubServiceSession(service=self)

    @property
    def credential_check_curl_arguments(self) -> tuple[str, ...]:
        return ("https://api.github.com/user",)

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


GITHUB = Github()
