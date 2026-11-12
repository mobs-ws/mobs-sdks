# mobs-ws

Official Python client for the MOBS `/v1/ws/metar` WebSocket (protocol 4).

The only runtime dependency is `websockets`. HTTP backfill uses urllib from
the standard library. Snapshot and resume are opt-in. The client applies
`awc_confirmed` frames last-wins per (`icao`, `versions`), handles
`station_late`, `station_recovered`, and `usage` (use `request_usage()`),
and ignores unknown frame types. Late alerts are kept as the latest frame per `outage_id` and cleared on `station_recovered`. More than one `station_late` can arrive in the same outage. A change-only `filter` and parsed
`delta` are opt-in on a mid-session `subscribe`, not on the handshake.

The API key is never embedded. Pass it to the constructor, or set
`MOBS_TOKEN`.

```bash
pip install mobs-ws
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
        on_record=lambda rec: print(rec["icao"], rec["raw_metar"], rec.get("awc_confirmed")),
    )
    await client.run_forever()

asyncio.run(main())
```

```bash
python -m mobs_ws --airports KNYC,KLGA
```

MIT licensed. See [LICENSE](https://github.com/mobs-ws/mobs-sdks/blob/main/LICENSE).
