# mobs-ws

Official JavaScript client for the MOBS `/v1/ws/metar` WebSocket (protocol 4).

There are no runtime dependencies. The client uses the global `WebSocket`
in the browser and in Node 22+. Snapshot and resume are opt-in. The client
applies `awc_confirmed` frames last-wins per (`icao`, `versions`),
handles `station_late`, `station_recovered`, and `usage` (use
`requestUsage()`), and ignores unknown frame types. Late alerts are kept as the latest frame per `outage_id` and cleared on `station_recovered`. More than one `station_late` can arrive in the same outage. A change-only
`filter` and parsed `delta` are opt-in on a mid-session `subscribe`,
not on the handshake.

The API key is never embedded. Pass it to the constructor, or set
`MOBS_TOKEN` (Node). In the browser, pass the token in and the client
uses `?token=` because a page cannot set socket headers. A browser
`WebSocket` cannot see a handshake 401 or 403, so the client retries.

```bash
npm install mobs-ws
export MOBS_TOKEN=$MOBS_TOKEN
```

```javascript
import { MetarClient } from "mobs-ws";

const client = new MetarClient({
  airports: ["KNYC", "KLGA"],
  token: process.env.MOBS_TOKEN, // or "YOUR_API_KEY"
  snapshot: true,
  resume: true,
  onRecord: (rec) => console.log(rec.icao, rec.raw_metar, rec.awc_confirmed),
});

await client.runForever();
```

MIT licensed. See [LICENSE](https://github.com/mobs-ws/mobs-sdks/blob/main/LICENSE).
