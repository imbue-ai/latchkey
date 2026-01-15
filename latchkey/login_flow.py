from playwright.sync_api import sync_playwright

from latchkey.credentials import Credentials
from latchkey.services import Service


def login(service: Service) -> Credentials:
    """
    Open a browser for the user to log in and extract credentials.

    Args:
        service: The Service instance to log in to.

    Returns:
        Credentials extracted from the browser session after successful login.
    """
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=False)
        context = browser.new_context()
        page = context.new_page()

        page.goto(service.login_url)
        service.wait_for_login_completed(page)
        credentials = service.extract_credentials(page)

        browser.close()

    return credentials
