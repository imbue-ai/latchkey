from abc import abstractmethod
from pathlib import Path

from playwright._impl._errors import TargetClosedError
from playwright.sync_api import Page
from playwright.sync_api import Playwright
from playwright.sync_api import Response
from playwright.sync_api import sync_playwright
from pydantic import BaseModel
from pydantic import ConfigDict
from pydantic import PrivateAttr

from latchkey.api_credentials import ApiCredentialStatus
from latchkey.api_credentials import ApiCredentials


class LoginCancelledError(Exception):
    """Raised when the user closes the browser before completing the login."""

    pass


class LoginFailedError(Exception):
    """Raised when the login completes but no credentials were extracted."""

    pass


class Service(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str
    base_api_urls: tuple[str, ...]
    login_url: str

    @abstractmethod
    def check_api_credentials(self, api_credentials: ApiCredentials) -> ApiCredentialStatus:
        pass

    @property
    def login_instructions(self) -> tuple[str, ...] | None:
        return None

    @abstractmethod
    def get_session(self) -> "ServiceSession":
        pass


class ServiceSession(BaseModel):
    model_config = ConfigDict(frozen=False, arbitrary_types_allowed=True)

    service: Service

    _api_credentials: ApiCredentials | None = PrivateAttr(default=None)

    @abstractmethod
    def _get_api_credentials_from_response(self, response: Response) -> ApiCredentials | None:
        pass

    def on_response(self, response: Response) -> None:
        if self._api_credentials is not None:
            return
        self._api_credentials = self._get_api_credentials_from_response(response)

    def _is_headful_login_complete(self) -> bool:
        """Return True when the headful browser login phase is complete.

        By default, this returns True when credentials have been extracted.
        Subclasses can override this to use different completion criteria
        (e.g., if credentials will be extracted during the followup step).
        """
        return self._api_credentials is not None

    def _wait_for_headful_login_complete(self, page: Page) -> None:
        """Wait until the headful browser login phase is complete."""
        while not self._is_headful_login_complete():
            page.wait_for_timeout(100)

    def _perform_followup(
        self,
        playwright: Playwright,
        api_credentials: ApiCredentials | None,
        browser_state_path: Path | None,
    ) -> ApiCredentials | None:
        """Perform a followup step after the headful browser login.

        This method is called after the headful browser is closed. Subclasses can
        override this to perform additional steps (e.g., headless requests) to
        complete credential extraction.

        Args:
            playwright: The Playwright instance (still active after headful browser closes).
            api_credentials: The credentials extracted during the headful login, or None
                if no credentials were extracted yet.
            browser_state_path: Path to the saved browser state from the headful session.

        Returns:
            The final ApiCredentials, or None if credentials are still incomplete.
        """
        return api_credentials

    def _show_login_instructions(self, page: Page) -> None:
        instructions = self.service.login_instructions
        if instructions is None:
            return

        instructions_list = "\n".join(f"<li>{item}</li>" for item in instructions)
        instructions_html = f"""
        <!DOCTYPE html>
        <html>
        <head>
            <title>Latchkey - Login Instructions</title>
            <style>
                body {{
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    min-height: 100vh;
                    margin: 0;
                    background: #f5f5f5;
                }}
                .container {{
                    background: white;
                    padding: 40px;
                    border-radius: 8px;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                    max-width: 500px;
                }}
                h1 {{
                    margin-top: 0;
                    color: #333;
                }}
                ul {{
                    line-height: 1.8;
                    color: #555;
                }}
                button {{
                    background: #007bff;
                    color: white;
                    border: none;
                    padding: 12px 24px;
                    font-size: 16px;
                    border-radius: 4px;
                    cursor: pointer;
                    margin-top: 20px;
                }}
                button:hover {{
                    background: #0056b3;
                }}
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Log in to {self.service.name}</h1>
                <ul>
                    {instructions_list}
                </ul>
                <button onclick="window.loginContinue = true">Continue to Login</button>
            </div>
        </body>
        </html>
        """
        page.set_content(instructions_html)
        page.wait_for_function("window.loginContinue === true")

    def login(self, browser_state_path: Path | None = None) -> ApiCredentials:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=False)
            context = browser.new_context(
                storage_state=str(browser_state_path) if browser_state_path and browser_state_path.exists() else None
            )
            page = context.new_page()

            page.on("response", lambda response: self.on_response(response))

            try:
                self._show_login_instructions(page)
                page.goto(self.service.login_url)
                self._wait_for_headful_login_complete(page)
            except TargetClosedError as error:
                raise LoginCancelledError("Login was cancelled because the browser was closed.") from error

            if browser_state_path:
                context.storage_state(path=str(browser_state_path))

            browser.close()

            api_credentials = self._perform_followup(playwright, self._api_credentials, browser_state_path)

        if api_credentials is None:
            raise LoginFailedError("Login failed: no credentials were extracted.")

        return api_credentials
