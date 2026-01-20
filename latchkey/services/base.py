from abc import abstractmethod
from concurrent.futures import Future

from playwright._impl._errors import TargetClosedError
from playwright.sync_api import Page
from playwright.sync_api import Request
from playwright.sync_api import sync_playwright
from pydantic import BaseModel
from pydantic import ConfigDict

from latchkey.credentials import CredentialStatus
from latchkey.credentials import Credentials


class LoginCancelledError(Exception):
    """Raised when the user closes the browser before completing the login."""

    pass


class Service(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str
    base_api_urls: tuple[str, ...]
    login_url: str

    @abstractmethod
    def _get_credentials_from_outgoing_request(self, request: Request) -> Credentials | None:
        pass

    def on_request(self, request: Request, credentials_future: Future[Credentials]) -> None:
        if credentials_future.done():
            return
        credentials = self._get_credentials_from_outgoing_request(request)
        if credentials is not None:
            credentials_future.set_result(credentials)

    @abstractmethod
    def check_credentials(self, credentials: Credentials) -> CredentialStatus:
        pass

    def wait_for_credentials(self, page: Page, credentials_future: Future[Credentials]) -> Credentials:
        while not credentials_future.done():
            page.wait_for_timeout(100)
        return credentials_future.result()

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

    def login(self) -> Credentials:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=False)
            context = browser.new_context()
            page = context.new_page()

            credentials_future: Future[Credentials] = Future()
            page.on("request", lambda request: self.on_request(request, credentials_future))

            try:
                self._show_login_instructions(page)
                page.goto(self.login_url)
                credentials = self.wait_for_credentials(page, credentials_future)
            except TargetClosedError as error:
                raise LoginCancelledError("Login was cancelled because the browser was closed.") from error

            browser.close()

        return credentials
