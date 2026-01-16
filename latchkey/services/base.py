from abc import abstractmethod

from playwright.sync_api import Page
from playwright.sync_api import sync_playwright
from pydantic import BaseModel
from pydantic import ConfigDict

from latchkey.credentials import Credentials


class CredentialExtractionError(Exception):
    pass


class Service(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str
    base_api_urls: tuple[str, ...]
    login_url: str

    @abstractmethod
    def wait_for_login_completed(self, page: Page) -> None:
        pass

    @abstractmethod
    def extract_credentials(self, page: Page) -> Credentials:
        pass

    def login(self) -> Credentials:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=False)
            context = browser.new_context()
            page = context.new_page()

            page.goto(self.login_url)
            self.wait_for_login_completed(page)
            credentials = self.extract_credentials(page)

            browser.close()

        return credentials
