# Changelog

Both packages (`mobs-ws` on PyPI and npm) share one version.

## 0.18.1 (unreleased)

Works with any 0.18.0-compatible server; `amended` needs server v0.46.0+. Nothing else changes.

- **`amended` on D-ATIS records:** `DatisRecord.amended` (Python, `bool = False`, after `versions`) is read by `from_dict` (only a real `true` counts). The new `DatisRecord.to_dict()` gives back the server's shape and field order, with `amended` only when true. JS: the `DatisRecord` JSDoc typedef gains the optional `amended`. The server sends `amended: true` when the letter changed under the same `issued_at` as the held bulletin for that icao and type (a real amendment, `revision` 0), and leaves it out otherwise. Both clients already passed it through on `on_datis` / `onDatis` and in `datis_latest` / `datisLatest`.
- **Time notes fixed:** record times end in `+00:00`. `issued_at` is `YYYY-MM-DDTHH:MM:00+00:00` (the broadcast's HHMMZ, no milliseconds), and `arrived_at` / `source_time` are `YYYY-MM-DDTHH:MM:SS.mmm+00:00`. `datis_time` is SWIM's `DATISTime` (ddhhmm), null from atis.info. Feed notice times and `/v1/status` `last_published_at` end in `Z`. Measure latency as `arrived_at` minus `source_time`, never from `issued_at`.

## 0.18.0

Needs server v0.44.0+ for D-ATIS and feed notices. METAR use is unchanged, and 0.17.0 keeps working against v0.44.0.

- **D-ATIS on `/v1/ws/metar`:**
  - The `datis` handshake option (`datis=` query).
  - `subscribe_datis` / `subscribeDatis` with `types`, and `unsubscribe_datis` / `unsubscribeDatis`.
  - `datis_types` / `datisTypes` are sent with a subscribe once the socket opens.
- **D-ATIS records:**
  - `new_datis_arrived` handling: kept per (icao, type), newest `issued_at` then `revision`.
  - The `on_datis` / `onDatis` callback.
  - Snapshots do not advance `seq`.
- **Resume:** a fallback with `datis_fallback` refetches `GET /v1/datis/latest`.
- **Types:** `DatisRecord` (Python dataclass, JS JSDoc typedef); JS also gets a `FeedNotice` typedef. `DATIS_TYPES`, `merge_datis` / `mergeDatis` and `fetch_datis_latest` / `fetchDatisLatest` are exported.
- **Feed notices:** `feed_notice` frames go to `notices` (whole state) and call `on_feed_notice` / `onFeedNotice`. Opt out with `notices=False` / `notices: false` (handshake `notices=false`), or toggle with `set_notices` / `setNotices`.
- **Old servers:** a server that predates D-ATIS (no `datis_icaos` on `subscription_updated`) is reported as "server does not support D-ATIS": `last_error` / `lastError` code `unsupported`, `datis_supported` / `datisSupported` false, and `subscribe_datis` raises or throws.
- **Error codes:** `ERROR_CODES` adds `forbidden` (no `datis` scope) and `unavailable` (D-ATIS off on the server).

## 0.17.0

- US `state` / `bbox` region grants and `polymarket_com` / `polymarket_us` platform grants.
