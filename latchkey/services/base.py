from abc import abstractmethod
from concurrent.futures import Future
from concurrent.futures import InvalidStateError
from pathlib import Path

from playwright._impl._errors import TargetClosedError
from playwright.sync_api import Page
from playwright.sync_api import Response
from playwright.sync_api import sync_playwright
from pydantic import BaseModel
from pydantic import ConfigDict

from latchkey.api_credentials import ApiCredentialStatus
from latchkey.api_credentials import ApiCredentials


class LoginCancelledError(Exception):
    """Raised when the user closes the browser before completing the login."""

    pass


class Service(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str
    base_api_urls: tuple[str, ...]
    login_url: str

    @abstractmethod
    def _get_api_credentials_from_response(self, response: Response, page: Page) -> ApiCredentials | None:
        pass

    def on_response(self, response: Response, page: Page, api_credentials_future: Future[ApiCredentials]) -> None:
        if api_credentials_future.done():
            return
        api_credentials = self._get_api_credentials_from_response(response, page)
        if api_credentials is not None:
            try:
                api_credentials_future.set_result(api_credentials)
            except InvalidStateError:
                pass

    @abstractmethod
    def check_api_credentials(self, api_credentials: ApiCredentials) -> ApiCredentialStatus:
        pass

    def wait_for_api_credentials(self, page: Page, api_credentials_future: Future[ApiCredentials]) -> ApiCredentials:
        while not api_credentials_future.done():
            page.wait_for_timeout(100)
        return api_credentials_future.result()

    @property
    def login_instructions(self) -> tuple[str, ...] | None:
        return None

    def _show_login_instructions(self, page: Page) -> None:
        instructions = self.login_instructions
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
                <h1>Log in to {self.name}</h1>
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

            api_credentials_future: Future[ApiCredentials] = Future()
            page.on("response", lambda response: self.on_response(response, page, api_credentials_future))

            try:
                self._show_login_instructions(page)
                page.goto(self.login_url)
                api_credentials = self.wait_for_api_credentials(page, api_credentials_future)
            except TargetClosedError as error:
                raise LoginCancelledError("Login was cancelled because the browser was closed.") from error

            if browser_state_path:
                context.storage_state(path=str(browser_state_path))

            browser.close()

        return api_credentials
