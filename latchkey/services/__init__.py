from latchkey.services.base import Service
from latchkey.services.discord import DISCORD
from latchkey.services.dropbox import DROPBOX
from latchkey.services.slack import SLACK
from latchkey.services.github import GITHUB

__all__ = ["Service", "SLACK", "DISCORD", "DROPBOX", "GITHUB"]
