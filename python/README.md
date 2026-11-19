# mobs-ws

Official Python client for the MOBS `/v1/ws/metar` WebSocket (protocol 4).

Requires Python 3.11+. `mobs-ws` 0.17.0+ for region and platform
subscriptions, 0.18.0 for D-ATIS and feed notices (server v0.44.0+), 0.18.1 for the `amended` D-ATIS flag (server v0.46.0+). The only runtime dependency is `websockets`. HTTP backfill
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
and `boot_id` as before, and re-subscribes held grants. The first
state, first bounding box, and first platform can be replayed; any
extra grants of the same kind are restored by snapshot, not replay.

The API key is never embedded. Pass it to the constructor, or set
`MOBS_TOKEN`.

```bash
pip install "mobs-ws>=0.18.1"
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

## D-ATIS and feed notices (0.18.0, server v0.44.0+)

Pass `datis=["KLGA"]` (handshake) or call `await client.subscribe_datis(["KJFK"], types=["combined"])`
mid-session; `await client.unsubscribe_datis([...])` drops them without touching METAR. The key
needs the `datis` scope. Each `new_datis_arrived` record is kept in `datis_latest` per
`(icao, type)`: a later `issued_at` wins, then a higher `revision`. `on_datis(record)` fires when
it changes. Snapshot frames (`cached: true`) do not advance `seq`. `backlog: true` marks a newer copy
that arrived late. `datis_types` (`combined`, `arr`, `dep`) are sent with a subscribe once the
socket opens. On a resume fallback with `datis_fallback`, the client refetches
`GET /v1/datis/latest`. `DatisRecord.from_dict()` gives a typed view, and `to_dict()` gives back the
server's shape.

Record times end in `+00:00`: `issued_at` is the broadcast's HHMMZ (`YYYY-MM-DDTHH:MM:00+00:00`, no
milliseconds), and `arrived_at` and `source_time` carry milliseconds. Feed notice times end in `Z`.
Measure latency as `arrived_at` minus `source_time`. From 0.18.1 (server v0.46.0+), `amended: true` marks
a new letter issued under the same `issued_at` (a real amendment, `revision` 0). The server leaves the
field out otherwise, and `DatisRecord.amended` is then `False`.

A server without D-ATIS answers with no `datis_icaos`. The client then sets `datis_supported = False`
and `last_error` to `{"code": "unsupported", "message": "server does not support D-ATIS"}`, and
`subscribe_datis()` raises `RuntimeError("server does not support D-ATIS")`. METAR keeps working.
A key without the scope gets `forbidden`, and a server with the product off gets `unavailable`;
both land on `last_error`.

`feed_notice` frames replace `client.notices` (whole state) and call `on_feed_notice(notices)`.
Opt out with `notices=False`, or later with `await client.set_notices(False)`.

D-ATIS from mobs-ws is not for operational or flight-safety use; it is best effort with no guarantee.

```python
client = MetarClient(
    ["KLGA"], datis=["KLGA"], datis_types=["combined"],
    on_datis=lambda rec: print(rec["icao"], rec["type"], rec["letter"], rec["text"][:60]),
    on_feed_notice=lambda notices: print([n["message"] for n in notices]),
)
```

MIT licensed. See [LICENSE](https://github.com/Mobs-ws/mobs-sdks/blob/main/LICENSE).
