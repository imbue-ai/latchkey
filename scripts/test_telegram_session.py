"""
Test script: convert web.telegram.org auth_key to Telethon session and verify it works.
"""

import asyncio
import base64
import ipaddress
import json
import struct

from telethon import TelegramClient
from telethon.sessions import StringSession

DC_IPS = {
    1: "149.154.175.53",
    2: "149.154.167.51",
    3: "149.154.175.100",
    4: "149.154.167.91",
    5: "91.108.56.130",
}

# Telegram Web A's official api credentials
API_ID = 2496
API_HASH = "8da85b0d5bfe62527e5b244c209159c3"


def web_auth_to_string_session(dc_id: int, auth_key_hex: str) -> str:
    """Convert web.telegram.org localStorage auth data to a Telethon StringSession."""
    ip_packed = ipaddress.ip_address(DC_IPS[dc_id]).packed
    auth_key_bytes = bytes.fromhex(auth_key_hex)
    assert len(auth_key_bytes) == 256, f"auth_key must be 256 bytes, got {len(auth_key_bytes)}"

    fmt = ">B{}sH256s".format(len(ip_packed))
    packed = struct.pack(fmt, dc_id, ip_packed, 443, auth_key_bytes)
    return "1" + base64.urlsafe_b64encode(packed).decode("ascii")


async def main() -> None:
    # Load auth data from the dump file
    with open("/tmp/latchkey-telegram-dump.json") as f:
        dump = json.load(f)

    ls = dump["localStorage"]
    dc_id = int(ls["dc"])
    auth_key_raw = ls[f"dc{dc_id}_auth_key"]
    # The value is JSON-encoded (wrapped in extra quotes)
    auth_key_hex = json.loads(auth_key_raw) if auth_key_raw.startswith('"') else auth_key_raw

    print(f"DC: {dc_id}")
    print(f"Auth key: {auth_key_hex[:32]}... ({len(auth_key_hex)} hex chars)")

    session_str = web_auth_to_string_session(dc_id, auth_key_hex)
    print(f"StringSession: {session_str[:40]}... ({len(session_str)} chars)")

    client = TelegramClient(StringSession(session_str), API_ID, API_HASH)
    await client.connect()

    if await client.is_user_authorized():
        me = await client.get_me()
        print(f"\nSUCCESS: Logged in as {me.first_name} {me.last_name or ''} (id={me.id}, username=@{me.username or 'N/A'})")
        print(f"Phone: {me.phone}")
    else:
        print("\nFAILED: Session is not authorized (auth_key may be invalid or expired)")

    await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
