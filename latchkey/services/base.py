from abc import ABC
from abc import abstractmethod
from pathlib import Path

from playwright._impl._errors import TargetClosedError
from playwright.sync_api import BrowserContext
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


class Service(ABC, BaseModel):
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


class ServiceSession(ABC, BaseModel):
    model_config = ConfigDict(frozen=False, arbitrary_types_allowed=True)

    service: Service

    def _wait_for_headful_login_complete(self, page: Page) -> None:
        """Wait until the headful browser login phase is complete."""
        while not self._is_headful_login_complete():
            page.wait_for_timeout(100)

    @abstractmethod
    def on_response(self, response: Response) -> None:
        pass

    @abstractmethod
    def _is_headful_login_complete(self) -> bool:
        pass

    @abstractmethod
    def _finalize_credentials(self, playwright: Playwright) -> ApiCredentials | None:
        pass

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

    def _on_headful_login_complete(self, context: BrowserContext) -> None:
        """Called after headful login completes but before the browser closes."""
        pass

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

            self._on_headful_login_complete(context)

            browser.close()

            api_credentials = self._finalize_credentials(playwright)

        if api_credentials is None:
            raise LoginFailedError("Login failed: no credentials were extracted.")

        return api_credentials


class SimpleServiceSession(ServiceSession):
    """
    The common case where API credentials are extracted simply by observing requests during the headful login phase.

    """

    _api_credentials: ApiCredentials | None = PrivateAttr(default=None)

    @abstractmethod
    def _get_api_credentials_from_response(self, response: Response) -> ApiCredentials | None:
        pass

    def on_response(self, response: Response) -> None:
        if self._api_credentials is not None:
            return
        self._api_credentials = self._get_api_credentials_from_response(response)

    def _is_headful_login_complete(self) -> bool:
        return self._api_credentials is not None

    def _finalize_credentials(self, playwright: Playwright) -> ApiCredentials | None:
        return self._api_credentials


class BrowserFollowupServiceSession(ServiceSession):
    """
    A session that requires a browser followup step to finalize credentials.

    The headful browser login phase captures login state. After login completes,
    the browser window is minimized and the same session is used for followup
    actions (e.g., navigating to a settings page and creating an API key).

    Subclasses must implement:
    - on_response: Handle responses during the headful login phase
    - _is_headful_login_complete: Return True when the user has logged in
    - _perform_browser_followup: Perform actions in the browser to get credentials
    """

    _browser_context: BrowserContext | None = PrivateAttr(default=None)
    _browser_page: Page | None = PrivateAttr(default=None)

    def _on_headful_login_complete(self, context: BrowserContext) -> None:
        self._browser_context = context
        # Get the page so we can minimize it
        pages = context.pages
        if pages:
            self._browser_page = pages[0]

    def _finalize_credentials(self, playwright: Playwright) -> ApiCredentials | None:
        if self._browser_context is None:
            return None

        # Minimize the browser window to hide it from the user during followup
        if self._browser_page is not None:
            cdp_session = self._browser_context.new_cdp_session(self._browser_page)
            cdp_session.send("Browser.setWindowBounds", {"windowId": 1, "bounds": {"windowState": "minimized"}})

        return self._perform_browser_followup(self._browser_context)

    @abstractmethod
    def _perform_browser_followup(self, context: BrowserContext) -> ApiCredentials | None:
        """
        Perform actions in a headless browser to finalize and extract API credentials.

        This method is called after the headful login phase completes. The browser
        context is initialized with the same state (cookies, localStorage, etc.)
        from the headful session, so the user is already authenticated.

        Typical actions include:
        - Navigating to an API key management page
        - Clicking buttons to create a new API key
        - Extracting the generated key from the page

        Args:
            context: A Playwright BrowserContext with the authenticated session state.

        Returns:
            The extracted API credentials, or None if extraction failed.
        """
        pass
