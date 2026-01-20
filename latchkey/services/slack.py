import json
import re

from playwright.sync_api import Page
from playwright.sync_api import Request

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

    _captured_token: str | None = None
    _captured_d_cookie: str | None = None

    @property
    def login_instructions(self) -> tuple[str, ...]:
        return (
            "Accept all cookies if prompted.",
            "Launch Slack in your browser (not the desktop app).",
        )

    def on_request(self, request: Request) -> None:
        if self._captured_token is not None and self._captured_d_cookie is not None:
            return

        url = request.url
        if not url.startswith("https://slack.com/api/") and not url.startswith("https://edgeapi.slack.com/"):
            return

        headers = request.headers

        if self._captured_token is None:
            authorization = headers.get("authorization")
            if authorization is not None and authorization.strip() != "":
                token = authorization
                if token.lower().startswith("bearer "):
                    token = token[7:]
                self._captured_token = token

        if self._captured_d_cookie is None:
            cookie_header = headers.get("cookie")
            if cookie_header is not None:
                match = re.search(r"\bd=([^;]+)", cookie_header)
                if match:
                    self._captured_d_cookie = match.group(1)

    def wait_for_login_completed(self, page: Page) -> None:
        while self._captured_token is None or self._captured_d_cookie is None:
            page.wait_for_timeout(100)

    def extract_credentials(self, page: Page) -> SlackCredentials:
        if self._captured_token is None:
            raise CredentialExtractionError("Could not capture Slack token from network requests")

        if self._captured_d_cookie is None:
            raise CredentialExtractionError("Could not capture Slack d cookie from network requests")

        return SlackCredentials(token=self._captured_token, d_cookie=self._captured_d_cookie)

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
