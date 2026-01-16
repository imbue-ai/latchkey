from latchkey.credentials.base import Credentials


class AuthorizationBearer(Credentials):
    token: str

    def as_curl_arguments(self) -> tuple[str, ...]:
        return ("-H", f"Authorization: Bearer {self.token}")
