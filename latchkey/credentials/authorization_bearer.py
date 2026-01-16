from latchkey.credentials.base import Credentials


class AuthorizationBearer(Credentials, frozen=True):
    """Credentials using Bearer token authentication via Authorization header."""

    token: str

    def as_curl_arguments(self) -> tuple[str, ...]:
        """Return curl command-line arguments for Bearer token authentication."""
        return ("-H", f"Authorization: Bearer {self.token}")
