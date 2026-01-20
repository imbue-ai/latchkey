import json

from playwright.sync_api import Page

from latchkey import curl
from latchkey.credentials import CredentialStatus
from latchkey.credentials import Credentials
from latchkey.services.base import CredentialExtractionError
from latchkey.services.base import Service


class SlackCredentials(Credentials):
    object_type: str = "slack"
    token: str
    d_cookie: str

    def as_curl_arguments(self) -> tuple[str, ...]:
        return (
            "-H",
            f"Authorization: Bearer {self.token}",
            "-H",
            f"Cookie: d={self.d_cookie}",
        )


class Slack(Service):
    name: str = "slack"
    base_api_urls: tuple[str, ...] = ("https://slack.com/api/",)
    login_url: str = "https://slack.com/signin"

    TOKEN_EXTRACTION_JS: str = """
        () => {
            const localConfig = JSON.parse(localStorage.getItem('localConfig_v2'));
            if (localConfig && localConfig.teams && localConfig.lastActiveTeamId) {
                return localConfig.teams[localConfig.lastActiveTeamId].token;
            }
            return null;
        }
    """

    @property
    def login_instructions(self) -> tuple[str, ...]:
        return (
            "Accept all cookies if prompted.",
            "Launch Slack in your browser (not the desktop app).",
        )

    def wait_for_login_completed(self, page: Page) -> None:
        # Match both https://app.slack.com/client/... and https://<workspace>.slack.com/client/...
        # Use wait_for_function instead of wait_for_url to avoid ERR_ABORTED errors
        # when the frame gets detached during SSB redirects.
        page.wait_for_function(
            """() => /^https:\\/\\/[a-zA-Z0-9-]+\\.slack\\.com\\/client\\//.test(window.location.href)""",
            timeout=0,
        )
        # Wait for the token to be present in localStorage
        page.wait_for_function(self.TOKEN_EXTRACTION_JS, timeout=0)

    def extract_credentials(self, page: Page) -> SlackCredentials:
        token = page.evaluate(self.TOKEN_EXTRACTION_JS)

        if not token:
            raise CredentialExtractionError("Could not extract Slack token from localStorage")

        context = page.context
        cookies = context.cookies()
        d_cookie = None
        for cookie in cookies:
            name = cookie.get("name")
            domain = cookie.get("domain", "")
            if name == "d" and "slack.com" in domain:
                d_cookie = cookie.get("value")
                break

        if not d_cookie:
            raise CredentialExtractionError("Could not extract Slack d cookie")

        return SlackCredentials(token=token, d_cookie=d_cookie)

    def check_credentials(self, credentials: Credentials) -> CredentialStatus:
        if not isinstance(credentials, SlackCredentials):
            return CredentialStatus.INVALID

        result = curl.run_captured(
            [
                "-s",
                *credentials.as_curl_arguments(),
                "https://slack.com/api/auth.test",
            ],
            timeout=10,
        )

        try:
            data = json.loads(result.stdout)
            if data.get("ok"):
                return CredentialStatus.VALID
            return CredentialStatus.INVALID
        except json.JSONDecodeError:
            return CredentialStatus.INVALID


SLACK = Slack()
