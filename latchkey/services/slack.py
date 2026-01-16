import re

from playwright.sync_api import Page

from latchkey.credentials import Credentials
from latchkey.services.base import Service


class SlackCredentials(Credentials):
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

    def wait_for_login_completed(self, page: Page, timeout: float = 30.0) -> None:
        page.wait_for_url(
            re.compile(r"https://app\.slack\.com/client/.*"),
            timeout=timeout * 1000,
        )

    def extract_credentials(self, page: Page) -> SlackCredentials:
        token = page.evaluate("""
            () => {
                const localConfig = JSON.parse(localStorage.getItem('localConfig_v2'));
                if (localConfig && localConfig.teams && localConfig.lastActiveTeamId) {
                    return localConfig.teams[localConfig.lastActiveTeamId].token;
                }
                return null;
            }
        """)

        if not token:
            raise ValueError("Could not extract Slack token from localStorage")

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
            raise ValueError("Could not extract Slack d cookie")

        return SlackCredentials(token=token, d_cookie=d_cookie)


SLACK = Slack()
