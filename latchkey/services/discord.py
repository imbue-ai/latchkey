from playwright.sync_api import Page
from playwright.sync_api import Request

from latchkey import curl
from latchkey.api_credentials import ApiCredentialStatus
from latchkey.api_credentials import ApiCredentials
from latchkey.api_credentials import AuthorizationBare
from latchkey.services.base import Service


class Discord(Service):
    name: str = "discord"
    base_api_urls: tuple[str, ...] = ("https://discord.com/api/",)
    login_url: str = "https://discord.com/login"

    def _get_api_credentials_from_outgoing_request(self, request: Request, page: Page) -> ApiCredentials | None:
        url = request.url
        if not url.startswith("https://discord.com/api/"):
            return None

        headers = request.headers
        authorization = headers.get("authorization")
        if authorization is not None and authorization.strip() != "":
            return AuthorizationBare(token=authorization)

        return None

    def check_api_credentials(self, api_credentials: ApiCredentials) -> ApiCredentialStatus:
        if not isinstance(api_credentials, AuthorizationBare):
            return ApiCredentialStatus.INVALID

        result = curl.run_captured(
            [
                "-s",
                "-o",
                "/dev/null",
                "-w",
                "%{http_code}",
                *api_credentials.as_curl_arguments(),
                "https://discord.com/api/v9/users/@me",
            ],
            timeout=10,
        )

        if result.stdout == "200":
            return ApiCredentialStatus.VALID
        return ApiCredentialStatus.INVALID


DISCORD = Discord()
