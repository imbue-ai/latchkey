import random

from playwright.sync_api import Locator
from playwright.sync_api import Page

# Typing delay range in milliseconds (min, max) to simulate human-like typing
TYPING_DELAY_MIN_MS = 30
TYPING_DELAY_MAX_MS = 100


def type_like_human(page: Page, locator: Locator, text: str) -> None:
    """Type text character by character with random delays to simulate human typing.

    This triggers proper JavaScript input events that some websites require,
    unlike fill() which sets the value directly.
    """
    locator.click()
    for character in text:
        locator.press_sequentially(character)
        delay = random.randint(TYPING_DELAY_MIN_MS, TYPING_DELAY_MAX_MS)
        page.wait_for_timeout(delay)
