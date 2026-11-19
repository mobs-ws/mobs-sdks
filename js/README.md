# mobs-ws

Official JavaScript client for the MOBS `/v1/ws/metar` WebSocket (protocol 4).

Requires Node 22+ (or a browser). `mobs-ws` 0.17.0+ for region and
platform subscriptions, 0.18.0 for D-ATIS and feed notices (server v0.44.0+), 0.18.1 for the `amended` D-ATIS flag (server v0.46.0+). There are no runtime dependencies. The client
uses the global `WebSocket` in the browser and in Node 22+. Snapshot
and resume are opt-in. The client applies `awc_confirmed` frames
last-wins per (`icao`, `versions`), handles `station_late`,
`station_recovered`, and `usage` (use `requestUsage()`), and ignores
unknown frame types. Late alerts are kept as the latest frame per
`outage_id` and cleared on `station_recovered`. More than one
`station_late` can arrive in the same outage. Snapshot frames are
marked `cached`; they are merged into `latest` and do not advance
`seq`.

A change-only `filter`, parsed `delta`, a US `state`, a `bbox`, and a
`platform` (`polymarket_com` or `polymarket_us`) are opt-in on a
mid-session `subscribe`, not on the handshake query. A region or
platform grant counts as one subscription; a socket may hold at most
10 grants. `invalid_region`, `unknown_platform`, and `too_many_grants`
are stored on `lastError`. On reconnect, the client passes `since_seq`
and `boot_id` as before, and re-subscribes held grants. The first
state, first bounding box, and first platform can be replayed; any
extra grants of the same kind are restored by snapshot, not replay.

The API key is never embedded. Pass it to the constructor, or set
`MOBS_TOKEN` (Node). In the browser, pass the token in and the client
uses `?token=` because a page cannot set socket headers. A browser
`WebSocket` cannot see a handshake 401 or 403, so the client retries.

```bash
npm install mobs-ws@0.18.1
export MOBS_TOKEN=$MOBS_TOKEN
```

```javascript
import { MetarClient } from "mobs-ws";

const client = new MetarClient({
  airports: ["KNYC", "KLGA"],
  token: process.env.MOBS_TOKEN, // or "YOUR_API_KEY"
  snapshot: true,
  resume: true,
  platform: "polymarket_com",
  onRecord: (rec) => console.log(rec.icao, rec.raw_metar, rec.awc_confirmed),
});

// Mid-session: client.subscribe([], {state: "NY"})
// or client.subscribe([], {bbox: {south:40.0,west:-75.0,north:41.5,east:-73.0}})
await client.runForever();
```

## D-ATIS and feed notices (0.18.0, server v0.44.0+)

Pass `datis: ["KLGA"]` (handshake) or call `client.subscribeDatis(["KJFK"], {types: ["combined"]})`
mid-session; `client.unsubscribeDatis([...])` drops them without touching METAR. The key needs
the `datis` scope. Each `new_datis_arrived` record (`DatisRecord` JSDoc type) is kept in
`datisLatest["ICAO/type"]`: a later `issued_at` wins, then a higher `revision`. `onDatis(record)`
fires when it changes. Snapshot frames (`cached: true`) do not advance `seq`. `backlog: true` marks a
newer copy that arrived late. `datisTypes` (`combined`, `arr`, `dep`) are sent with a subscribe
once the socket opens. On a resume fallback with `datis_fallback`, the client refetches
`GET /v1/datis/latest`.

Records are the server's objects, unchanged. Record times end in `+00:00`: `issued_at` is the
broadcast's HHMMZ (`YYYY-MM-DDTHH:MM:00+00:00`, no milliseconds), and `arrived_at` and `source_time` carry
milliseconds. Feed notice times end in `Z`. Measure latency as `arrived_at` minus `source_time`.
From 0.18.1 (server v0.46.0+), `amended: true` marks a new letter issued under the same
`issued_at` (a real amendment, `revision` 0). The field is absent otherwise.

A server without D-ATIS answers with no `datis_icaos`. The client then sets `datisSupported = false`
and `lastError` to `{code: "unsupported", message: "server does not support D-ATIS"}`, and
`subscribeDatis()` throws `Error("server does not support D-ATIS")`. METAR keeps working.
A key without the scope gets `forbidden`, and a server with the product off gets `unavailable`;
both land on `lastError`.

`feed_notice` frames replace `client.notices` (whole state, `FeedNotice` JSDoc type) and call
`onFeedNotice(notices)`. Opt out with `notices: false`, or later with `client.setNotices(false)`.

D-ATIS from mobs-ws is not for operational or flight-safety use; it is best effort with no guarantee.

```javascript
const client = new MetarClient({
  airports: ["KLGA"], datis: ["KLGA"], datisTypes: ["combined"],
  onDatis: (rec) => console.log(rec.icao, rec.type, rec.letter, rec.text.slice(0, 60)),
  onFeedNotice: (notices) => console.log(notices.map((n) => n.message)),
});
```

MIT licensed. See [LICENSE](https://github.com/Mobs-ws/mobs-sdks/blob/main/LICENSE).
