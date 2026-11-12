# MOBS client SDKs

Official Python and JavaScript clients for the MOBS `/v1/ws/metar`
WebSocket. Full documentation: https://docs.mobs.ws

| Language | Package | Install | Source |
| --- | --- | --- | --- |
| Python 3.11+ | [`mobs-ws`](https://pypi.org/project/mobs-ws/) | `pip install mobs-ws` | [`python/`](python/) |
| JavaScript (Node 22+, browsers) | [`mobs-ws`](https://www.npmjs.com/package/mobs-ws) | `npm install mobs-ws` | [`js/`](js/) |

Both clients speak **protocol 4** (snapshot, resume, `awc_confirmed`,
`station_late` / `station_recovered`, change-only `filter`, parsed `delta`,
and the `usage` frame). They ignore unknown frame types, so newer servers
stay compatible. Your API key is never embedded: pass it in or set
`MOBS_TOKEN`.

## Releases

Each package is released from GitHub Actions with no stored registry tokens:

- Python: push a tag `python-vX.Y.Z` → `.github/workflows/publish-python.yml`
  (PyPI Trusted Publishing).
- JavaScript: push a tag `js-vX.Y.Z` → `.github/workflows/publish-js.yml`
  (npm trusted publishing with provenance).

The tag version must match the version in `python/pyproject.toml` or
`js/package.json`, or the workflow stops before publishing.

## License

[MIT](LICENSE)
