import json
import re

from playwright.sync_api import Request

from latchkey import curl
from latchkey.credentials import CredentialStatus
from latchkey.credentials import Credentials
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

    @property
    def login_instructions(self) -> tuple[str, ...]:
        return (
            "Accept all cookies if prompted.",
            "Launch Slack in your browser (not the desktop app).",
        )

    def on_request(self, request: Request) -> None:
        if self._credentials is not None:
            return

        url = request.url
        if not url.startswith("https://slack.com/api/") and not url.startswith("https://edgeapi.slack.com/"):
            return

        headers = request.headers

        authorization = headers.get("authorization")
        if authorization is None or authorization.strip() == "":
            return
        token = authorization
        if token.lower().startswith("bearer "):
            token = token[7:]

        cookie_header = headers.get("cookie")
        if cookie_header is None:
            return
        match = re.search(r"\bd=([^;]+)", cookie_header)
        if not match:
            return
        d_cookie = match.group(1)

        self._credentials = SlackCredentials(token=token, d_cookie=d_cookie)

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
