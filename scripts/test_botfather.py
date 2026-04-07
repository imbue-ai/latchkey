"""
Test: send a message to BotFather and read the response.
Just sends /mybots to check we can communicate, doesn't create anything.
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

API_ID = 2496
API_HASH = "8da85b0d5bfe62527e5b244c209159c3"


def web_auth_to_string_session(dc_id: int, auth_key_hex: str) -> str:
    ip_packed = ipaddress.ip_address(DC_IPS[dc_id]).packed
    auth_key_bytes = bytes.fromhex(auth_key_hex)
    fmt = ">B{}sH256s".format(len(ip_packed))
    packed = struct.pack(fmt, dc_id, ip_packed, 443, auth_key_bytes)
    return "1" + base64.urlsafe_b64encode(packed).decode("ascii")


async def main() -> None:
    with open("/tmp/latchkey-telegram-dump.json") as f:
        dump = json.load(f)

    ls = dump["localStorage"]
    dc_id = int(ls["dc"])
    auth_key_raw = ls[f"dc{dc_id}_auth_key"]
    auth_key_hex = json.loads(auth_key_raw) if auth_key_raw.startswith('"') else auth_key_raw

    session_str = web_auth_to_string_session(dc_id, auth_key_hex)
    client = TelegramClient(StringSession(session_str), API_ID, API_HASH)
    await client.connect()

    if not await client.is_user_authorized():
        print("Not authorized")
        return

    me = await client.get_me()
    print(f"Logged in as {me.first_name} (id={me.id})")

    # Send /mybots to BotFather (a safe read-only command)
    botfather = await client.get_entity("@BotFather")
    print(f"\nBotFather entity: {botfather.id}, {botfather.first_name}")

    await client.send_message(botfather, "/mybots")
    print("Sent /mybots to BotFather")

    # Wait a moment for the reply
    await asyncio.sleep(2)

    # Read recent messages from BotFather
    messages = await client.get_messages(botfather, limit=3)
    print(f"\nLast {len(messages)} messages from BotFather conversation:")
    for msg in reversed(messages):
        sender = "You" if msg.out else "BotFather"
        text = msg.text or "(no text)"
        print(f"  [{sender}]: {text[:200]}")

    await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
