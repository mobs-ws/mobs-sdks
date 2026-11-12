from __future__ import annotations

import argparse
import asyncio
import os
import sys

from mobs_ws.client import DEFAULT_URL, MetarClient, resolve_token


def main() -> None:
    parser = argparse.ArgumentParser(description="MOBS /v1/ws/metar official client")
    parser.add_argument("--url", default=os.environ.get("MOBS_WS_URL", DEFAULT_URL))
    parser.add_argument("--airports", default="KNYC,KLGA")
    parser.add_argument("--token", default=None)
    args = parser.parse_args()
    try:
        token = resolve_token(args.token)
    except ValueError:
        sys.exit("set MOBS_TOKEN or pass --token; use the placeholder YOUR_API_KEY in examples only")
    airports = [part.strip() for part in args.airports.split(",") if part.strip()]
    client = MetarClient(airports, token=token, url=args.url)
    asyncio.run(client.run_forever())


if __name__ == "__main__":
    main()
