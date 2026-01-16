from playwright.sync_api import Page

from latchkey.credentials import AuthorizationBearer
from latchkey.services.base import CredentialExtractionError
from latchkey.services.base import Service


class Discord(Service):
    name: str = "discord"
    base_api_urls: tuple[str, ...] = ("https://discord.com/api/",)
    login_url: str = "https://discord.com/login"

    TOKEN_EXTRACTION_JS: str = """
        () => {
            // Try to extract token from localStorage
            // Discord stores the token in various localStorage keys
            const token = (webpackChunkdiscord_app.push([[''],{},e=>{m=[];for(let c in e.c)m.push(e.c[c])}]),m).find(m=>m?.exports?.default?.getToken!==void 0).exports.default.getToken();
            return token || null;
        }
    """

    @property
    def login_instructions(self) -> tuple[str, ...]:
        return (
            "Sign in with your Discord account credentials",
            "Complete any two-factor authentication if prompted",
            "The browser will close automatically once login is complete",
        )

    def wait_for_login_completed(self, page: Page) -> None:
        # Wait for navigation to the Discord app (channels page)
        page.wait_for_function(
            """() => /^https:\\/\\/discord\\.com\\/(channels|app)/.test(window.location.href)""",
            timeout=0,
        )
        # Wait for the token to be extractable
        page.wait_for_function(self.TOKEN_EXTRACTION_JS, timeout=0)

    def extract_credentials(self, page: Page) -> AuthorizationBearer:
        token = page.evaluate(self.TOKEN_EXTRACTION_JS)

        if not token:
            raise CredentialExtractionError("Could not extract Discord token from browser")

        return AuthorizationBearer(token=token)


DISCORD = Discord()
