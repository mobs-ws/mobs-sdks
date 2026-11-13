# mobs-ws

Official JavaScript client for the MOBS `/v1/ws/metar` WebSocket (protocol 4).

Requires Node 22+ (or a browser) and `mobs-ws` 0.17.0 for region and
platform subscriptions. There are no runtime dependencies. The client
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
and `boot_id` as before, and re-subscribes held grants so those
stations can be replayed.

The API key is never embedded. Pass it to the constructor, or set
`MOBS_TOKEN` (Node). In the browser, pass the token in and the client
uses `?token=` because a page cannot set socket headers. A browser
`WebSocket` cannot see a handshake 401 or 403, so the client retries.

```bash
npm install mobs-ws@0.17.0
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

MIT licensed. See [LICENSE](https://github.com/Mobs-ws/mobs-sdks/blob/main/LICENSE).
