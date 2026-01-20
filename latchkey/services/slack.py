import json
import re

from playwright.sync_api import Page
from playwright.sync_api import Request

from latchkey import curl
from latchkey.api_credentials import ApiCredentialStatus
from latchkey.api_credentials import ApiCredentials
from latchkey.services.base import Service


class SlackApiCredentials(ApiCredentials):
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


TOKEN_EXTRACTION_JS: str = """
    () => {
        const localConfig = JSON.parse(localStorage.getItem('localConfig_v2'));
        if (localConfig && localConfig.teams && localConfig.lastActiveTeamId) {
            return localConfig.teams[localConfig.lastActiveTeamId].token;
        }
        return null;
    }
"""


class Slack(Service):
    name: str = "slack"
    base_api_urls: tuple[str, ...] = ("https://slack.com/api/",)
    login_url: str = "https://slack.com/signin"

    @property
    def login_instructions(self) -> tuple[str, ...]:
        return (
            "Accept all cookies if prompted.",
            "Launch Slack in your browser (not the desktop app).",
        )

    def _get_api_credentials_from_outgoing_request(self, request: Request, page: Page) -> ApiCredentials | None:
        url = request.url
        # Check if the domain is under slack.com:
        if not re.match(r"https://([a-z0-9-]+\.)?slack\.com/", url):
            return None

        headers = request.headers

        cookie_header = headers.get("cookie")
        if cookie_header is None:
            return None
        match = re.search(r"\bd=([^;]+)", cookie_header)
        if not match:
            return None
        d_cookie = match.group(1)

        token = page.evaluate(TOKEN_EXTRACTION_JS)
        if token is None:
            return None

        return SlackApiCredentials(token=token, d_cookie=d_cookie)

    def check_api_credentials(self, api_credentials: ApiCredentials) -> ApiCredentialStatus:
        if not isinstance(api_credentials, SlackApiCredentials):
            return ApiCredentialStatus.INVALID

        result = curl.run_captured(
            [
                "-s",
                *api_credentials.as_curl_arguments(),
                "https://slack.com/api/auth.test",
            ],
            timeout=10,
        )

        try:
            data = json.loads(result.stdout)
            if data.get("ok"):
                return ApiCredentialStatus.VALID
            return ApiCredentialStatus.INVALID
        except json.JSONDecodeError:
            return ApiCredentialStatus.INVALID


SLACK = Slack()
