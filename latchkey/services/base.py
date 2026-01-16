from abc import abstractmethod

from playwright.sync_api import Page, sync_playwright
from pydantic import BaseModel

from latchkey.credentials import Credentials


class Service(BaseModel, frozen=True):
    """Abstract base class for third-party services."""

    name: str
    base_api_url: str
    login_url: str

    @abstractmethod
    def wait_for_login_completed(self, page: Page, timeout: float = 30.0) -> None:
        """
        Wait for the login process to complete.

        Args:
            page: The Playwright Page object representing the browser page.
            timeout: Maximum time to wait in seconds (default: 30.0).

        Raises:
            TimeoutError: If login does not complete within the timeout period.
        """
        pass

    @abstractmethod
    def extract_credentials(self, page: Page) -> Credentials:
        """
        Extract credentials from the browser page after successful login.

        Args:
            page: The Playwright Page object representing the browser page.

        Returns:
            A Credentials object containing the extracted credentials.
        """
        pass

    def login(self) -> Credentials:
        """
        Open a browser for the user to log in and extract credentials.

        Returns:
            Credentials extracted from the browser session after successful login.
        """
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=False)
            context = browser.new_context()
            page = context.new_page()

            page.goto(self.login_url)
            self.wait_for_login_completed(page)
            credentials = self.extract_credentials(page)

            browser.close()

        return credentials
