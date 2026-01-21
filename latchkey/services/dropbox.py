import json
import re
import urllib.parse
import uuid

from playwright.sync_api import Response
from pydantic import PrivateAttr

from latchkey import curl
from latchkey.api_credentials import ApiCredentialStatus
from latchkey.api_credentials import ApiCredentials
from latchkey.api_credentials import AuthorizationBearer
from latchkey.services.base import Service
from latchkey.services.base import ServiceSession


class DropboxTokenGenerationError(Exception):
    pass


class DropboxServiceSession(ServiceSession):
    _csrf_token: str | None = PrivateAttr(default=None)
    _cookies: str | None = PrivateAttr(default=None)
    _is_logged_in: bool = PrivateAttr(default=False)

    def on_response(self, response: Response) -> None:
        if self._is_logged_in:
            return

        request = response.request
        url = request.url

        # Check if this is a request to www.dropbox.com
        if not url.startswith("https://www.dropbox.com/"):
            return

        headers = request.all_headers()
        cookie_header = headers.get("cookie")
        if cookie_header is None:
            return

        # Extract CSRF token from __Host-js_csrf cookie
        csrf_match = re.search(r"__Host-js_csrf=([^;]+)", cookie_header)
        if csrf_match is None:
            return

        # Check for session cookies that indicate the user is logged in
        # The 'jar' cookie contains session info and is present when logged in
        if "jar=" not in cookie_header:
            return

        self._csrf_token = csrf_match.group(1)
        self._cookies = cookie_header
        self._is_logged_in = True

    def _is_headful_login_complete(self) -> bool:
        return self._is_logged_in

    def _finalize_credentials(self) -> ApiCredentials | None:
        if self._csrf_token is None or self._cookies is None:
            return None

        # Generate a unique app name to avoid conflicts
        app_name = f"Latchkey-{uuid.uuid4().hex[:8]}"

        # Step 1: Create a new Dropbox app
        app_id = self._create_app(app_name)

        # Step 2: Generate an access token for the app
        token = self._generate_access_token(app_id)

        return AuthorizationBearer(token=token)

    def _create_app(self, app_name: str) -> str:
        data = urllib.parse.urlencode(
            {
                "is_xhr": "true",
                "t": self._csrf_token,
                "app_version": "scoped",
                "access_type": "full_permissions",
                "name": app_name,
            }
        )

        result = curl.run_captured(
            [
                "-s",
                "-L",  # Follow redirects
                "-H",
                "Accept: */*",
                "-H",
                "Content-Type: application/x-www-form-urlencoded; charset=UTF-8",
                "-H",
                f"Cookie: {self._cookies}",
                "-H",
                "Origin: https://www.dropbox.com",
                "-H",
                "Referer: https://www.dropbox.com/developers/apps/create",
                "-H",
                "Sec-Fetch-Dest: empty",
                "-H",
                "Sec-Fetch-Mode: cors",
                "-H",
                "Sec-Fetch-Site: same-origin",
                "-A",
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
                "-d",
                data,
                "https://www.dropbox.com/developers/apps/create/submit",
            ],
            timeout=30,
        )

        if result.returncode != 0:
            raise DropboxTokenGenerationError(f"Failed to create Dropbox app: curl exit code {result.returncode}")

        response_text = result.stdout

        # The response redirects to the app info page
        # We need to extract the app_id from the HTML
        # Look for: <input name="app_id" type="hidden" value="8220113" />
        app_id_match = re.search(r'<input[^>]*name="app_id"[^>]*value="(\d+)"', response_text)
        if app_id_match is None:
            # Try alternative pattern
            app_id_match = re.search(r"AppInfoPage\.default\.init\((\d+)\)", response_text)

        if app_id_match is None:
            raise DropboxTokenGenerationError("Failed to extract app_id from Dropbox response")

        return app_id_match.group(1)

    def _generate_access_token(self, app_id: str) -> str:
        data = urllib.parse.urlencode(
            {
                "is_xhr": "true",
                "t": self._csrf_token,
                "app_id": app_id,
            }
        )

        result = curl.run_captured(
            [
                "-s",
                "-H",
                "Accept: */*",
                "-H",
                "Content-Type: application/x-www-form-urlencoded; charset=UTF-8",
                "-H",
                f"Cookie: {self._cookies}",
                "-H",
                "Origin: https://www.dropbox.com",
                "-H",
                f"Referer: https://www.dropbox.com/developers/apps/info/{app_id}",
                "-H",
                "Sec-Fetch-Dest: empty",
                "-H",
                "Sec-Fetch-Mode: cors",
                "-H",
                "Sec-Fetch-Site: same-origin",
                "-A",
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
                "-d",
                data,
                "https://www.dropbox.com/developers/apps/generate_access_token",
            ],
            timeout=30,
        )

        if result.returncode != 0:
            raise DropboxTokenGenerationError(f"Failed to generate access token: curl exit code {result.returncode}")

        response_text = result.stdout

        try:
            response_data = json.loads(response_text)
        except json.JSONDecodeError as error:
            raise DropboxTokenGenerationError(f"Invalid JSON response from Dropbox: {response_text[:200]}") from error

        if response_data.get("status") != "ok":
            raise DropboxTokenGenerationError(f"Dropbox API error: {response_data}")

        token = response_data.get("token")
        if token is None:
            raise DropboxTokenGenerationError("No token in Dropbox response")

        return token


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
