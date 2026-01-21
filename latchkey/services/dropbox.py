from playwright.sync_api import Response

from latchkey import curl
from latchkey.api_credentials import ApiCredentialStatus
from latchkey.api_credentials import ApiCredentials
from latchkey.api_credentials import AuthorizationBearer
from latchkey.services.base import Service
from latchkey.services.base import SimpleServiceSession


class DropboxServiceSession(SimpleServiceSession):
    def _get_api_credentials_from_response(self, response: Response) -> ApiCredentials | None:
        request = response.request
        url = request.url
        if not url.startswith("https://api.dropboxapi.com/"):
            return None

        headers = request.headers
        authorization = headers.get("authorization")
        if authorization is not None and authorization.startswith("Bearer "):
            token = authorization[len("Bearer ") :]
            return AuthorizationBearer(token=token)

        return None


class Dropbox(Service):
    name: str = "dropbox"
    base_api_urls: tuple[str, ...] = ("https://api.dropboxapi.com/",)
    login_url: str = "https://www.dropbox.com/login"

    def get_session(self) -> DropboxServiceSession:
        return DropboxServiceSession(service=self)

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
                "https://api.dropboxapi.com/2/check/user",
                "-d",
                "null",
            ],
            timeout=10,
        )

        if result.stdout == "200":
            return ApiCredentialStatus.VALID
        return ApiCredentialStatus.INVALID


DROPBOX = Dropbox()
