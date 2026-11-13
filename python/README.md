# mobs-ws

Official Python client for the MOBS `/v1/ws/metar` WebSocket (protocol 4).

Requires Python 3.11+ and `mobs-ws` 0.17.0 for region and platform
subscriptions. The only runtime dependency is `websockets`. HTTP backfill
uses urllib from the standard library. Snapshot and resume are opt-in.
The client applies `awc_confirmed` frames last-wins per (`icao`,
`versions`), handles `station_late`, `station_recovered`, and `usage`
(use `request_usage()`), and ignores unknown frame types. Late alerts
are kept as the latest frame per `outage_id` and cleared on
`station_recovered`. More than one `station_late` can arrive in the
same outage. Snapshot frames are marked `cached`; they are merged into
`latest` and do not advance `seq`.

A change-only `filter`, parsed `delta`, a US `state`, a `bbox`, and a
`platform` (`polymarket_com` or `polymarket_us`) are opt-in on a
mid-session `subscribe`, not on the handshake query. A region or
platform grant counts as one subscription; a socket may hold at most
10 grants. `invalid_region`, `unknown_platform`, and `too_many_grants`
are stored on `last_error`. On reconnect, the client passes `since_seq`
and `boot_id` as before, and re-subscribes held grants so those
stations can be replayed.

The API key is never embedded. Pass it to the constructor, or set
`MOBS_TOKEN`.

```bash
pip install "mobs-ws>=0.17.0"
export MOBS_TOKEN=$MOBS_TOKEN
```

```python
import asyncio
import os

from mobs_ws import MetarClient

async def main():
    client = MetarClient(
        airports=["KNYC", "KLGA"],
        token=os.environ["MOBS_TOKEN"],  # or token="YOUR_API_KEY"
        snapshot=True,
        resume=True,
        platform="polymarket_com",
        on_record=lambda rec: print(rec["icao"], rec["raw_metar"], rec.get("awc_confirmed")),
    )
    # Mid-session: await client.subscribe(state="NY")
    # or await client.subscribe(bbox={"south":40.0,"west":-75.0,"north":41.5,"east":-73.0})
    await client.run_forever()

asyncio.run(main())
```

```bash
python -m mobs_ws --airports KNYC,KLGA
```

MIT licensed. See [LICENSE](https://github.com/Mobs-ws/mobs-sdks/blob/main/LICENSE).
