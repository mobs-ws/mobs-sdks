# Changelog

Both packages (`mobs-ws` on PyPI and npm) share one version.

## 0.18.0 (unreleased)

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
