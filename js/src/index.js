// Official client for MOBS /v1/ws/metar (protocol 4).
// Promoted from examples/ws_client.js and the WebSocket API page sample.
// No runtime dependencies: uses the global WebSocket (browser and Node 22+).
// The token comes only from the caller or the MOBS_TOKEN environment
// variable. It is never embedded.
// 0.18.1: the optional `amended` field on DatisRecord (server v0.46.0+) and
// corrected record time notes.
// 0.18.0 (server v0.44.0+): per-station D-ATIS (`datis` option or
// subscribeDatis(); the key needs the `datis` scope), new_datis_arrived kept
// per (icao, type) newest issued_at then revision, onDatis, datis_fallback
// resync from GET /v1/datis/latest, and feed_notice (`notices`,
// onFeedNotice; opt out with `notices: false`).

export const DEFAULT_URL = "wss://mobs.ws/v1/ws/metar";
export const MAX_GRANTS = 10;
export const KNOWN_PLATFORMS = Object.freeze(["polymarket_com", "polymarket_us"]);
export const ERROR_CODES = Object.freeze([
  "invalid_airports",
  "bad_request",
  "unknown_action",
  "too_many_airports",
  "invalid_region",
  "unknown_platform",
  "too_many_grants",
  "forbidden",
  "unavailable",
]);
export const DATIS_TYPES = Object.freeze(["combined", "arr", "dep"]);
export const DATIS_UNSUPPORTED = "server does not support D-ATIS";
export const PING_EVERY_MS = 20000;
export const PONG_TIMEOUT_MS = 15000;
export const BACKOFF_START_MS = 1000;
export const BACKOFF_CAP_MS = 30000;
export const QUIET_OPEN_MS = 10000;

export function resolveToken(token) {
  const env =
    typeof process !== "undefined" && process.env && process.env.MOBS_TOKEN
      ? process.env.MOBS_TOKEN
      : "";
  const value = token == null || token === "" ? env : token;
  if (!value) {
    throw new Error("pass a token or set MOBS_TOKEN");
  }
  return value;
}

export function shouldRetry(code) {
  return code !== 4403;
}

export function nextBackoff(delay, rand = Math.random) {
  const grown = Math.min(delay * 2, BACKOFF_CAP_MS);
  return grown * (0.5 + rand());
}

function newerThan(incoming, held) {
  if (incoming.versions !== held.versions) return true;
  if (
    incoming.icao !== held.icao ||
    incoming.obs_time !== held.obs_time ||
    incoming.raw_metar !== held.raw_metar
  ) {
    return true;
  }
  return incoming._live && !held._live;
}

export function mergeRecord(latest, record, live = false) {
  const item = Object.assign({}, record, {_live: live});
  const icao = item.icao;
  if (!icao) return latest;
  const held = latest[icao];
  if (!held || newerThan(item, held)) latest[icao] = item;
  return latest;
}

export function applyAwcConfirmed(latest, message) {
  const icao = message.icao;
  const versions = message.versions;
  if (!icao || versions == null) return latest;
  const held = latest[icao];
  if (!held || held.versions !== versions) return latest;
  held.awc_confirmed = true;
  held.awc_confirmed_at = message.awc_confirmed_at;
  return latest;
}

/**
 * One D-ATIS bulletin (`data[]` of new_datis_arrived, and GET /v1/datis rows).
 * Records are the server's plain objects, passed through unchanged (unknown fields kept).
 * Record times end in `+00:00`; feed notice times and /v1/status `last_published_at` end in `Z`.
 * Measure latency as `arrived_at` minus `source_time`, never from `issued_at`.
 * @typedef {Object} DatisRecord
 * @property {string} icao
 * @property {"combined"|"arr"|"dep"} type
 * @property {string} letter
 * @property {string} issued_at      The broadcast's HHMMZ, "YYYY-MM-DDTHH:MM:00+00:00" (no milliseconds)
 * @property {string|null} datis_time SWIM DATISTime (ddhhmm) as sent; null from atis.info
 * @property {string} text
 * @property {string} arrived_at     "YYYY-MM-DDTHH:MM:SS.mmm+00:00"
 * @property {"swim"|"atis.info"} source
 * @property {string|null} source_time "YYYY-MM-DDTHH:MM:SS.mmm+00:00" (SWIM sender stamp or atis.info updatedAt), or null
 * @property {number} revision
 * @property {string} versions       e.g. "KLGA/combined/U/2026-11-19T11:51Z/0"
 * @property {boolean} [amended]     0.18.1 (server v0.46.0+): true when the letter changed under the same
 *                                   issued_at as the held bulletin for this icao/type (a real amendment,
 *                                   revision 0); absent otherwise, never false
 */

/**
 * One feed notice (`feed_notice.notices[]` and /v1/status `notices[]`).
 * @typedef {Object} FeedNotice
 * @property {string} id
 * @property {"metar"|"datis"} feed
 * @property {string|null} source
 * @property {string[]|null} icaos
 * @property {string} kind
 * @property {string} message
 * @property {string} starts_at    "YYYY-MM-DDTHH:MM:SS.mmmZ"
 * @property {string|null} ends_at "YYYY-MM-DDTHH:MM:SS.mmmZ", or null
 * @property {string} posted_at    "YYYY-MM-DDTHH:MM:SS.mmmZ"
 * @property {string} posted_by
 */

export function datisKey(record) {
  return String((record && record.icao) || "").toUpperCase() + "/" + String((record && record.type) || "");
}

/** Keep the newest bulletin per icao/type: later issued_at, then higher revision. True when it changed. */
export function mergeDatis(latest, record) {
  if (!record || !record.icao || !record.type) return false;
  const key = datisKey(record);
  const held = latest[key];
  if (held) {
    if (record.versions === held.versions) return false;
    const mine = String(record.issued_at || "");
    const theirs = String(held.issued_at || "");
    if (mine < theirs) return false;
    if (mine === theirs && Number(record.revision || 0) < Number(held.revision || 0)) return false;
  }
  latest[key] = Object.assign({}, record);
  return true;
}

export function handshakeUrl(base, airports, {snapshot = true, sinceSeq = null, bootId = null, datis = null, notices = true} = {}) {
  const url = new URL(base);
  url.searchParams.set("airports", airports.join(","));
  if (datis && datis.length) url.searchParams.set("datis", datis.join(","));
  if (!notices) url.searchParams.set("notices", "false");
  if (snapshot) url.searchParams.set("snapshot", "true");
  if (sinceSeq != null && bootId) {
    url.searchParams.set("since_seq", String(sinceSeq));
    url.searchParams.set("boot_id", bootId);
  }
  return url.toString();
}

export function latestUrl(wsUrl, airports, path = "/v1/metar/latest") {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" || url.protocol === "https:" ? "https:" : "http:";
  url.pathname = path;
  url.search = new URLSearchParams({airports: airports.join(",")}).toString();
  return url.toString();
}

export async function fetchLatest(wsUrl, token, airports) {
  try {
    const headers = token ? {Authorization: "Bearer " + token} : {};
    const response = await fetch(latestUrl(wsUrl, airports), {headers});
    if (!response.ok) return [];
    const body = await response.json();
    return body.data || [];
  } catch {
    return [];
  }
}

export function datisLatestUrl(wsUrl, icaos) {
  return latestUrl(wsUrl, icaos, "/v1/datis/latest");
}

export async function fetchDatisLatest(wsUrl, token, icaos) {
  if (!icaos || !icaos.length) return [];
  try {
    const headers = token ? {Authorization: "Bearer " + token} : {};
    const response = await fetch(datisLatestUrl(wsUrl, icaos), {headers});
    if (!response.ok) return [];
    const body = await response.json();
    return body.data || [];
  } catch {
    return [];
  }
}

function isBrowser() {
  return typeof window !== "undefined" && typeof window.document !== "undefined";
}

function openWebSocket(url, token) {
  if (!isBrowser() && token) {
    try {
      return new WebSocket(url, {headers: {Authorization: "Bearer " + token}});
    } catch {
      // Fall through to the query form used in browsers.
    }
  }
  const target = new URL(url);
  if (token && !target.searchParams.has("token")) {
    target.searchParams.set("token", token);
  }
  return new WebSocket(target.toString());
}

function outageKey(message) {
  return (message && (message.outage_id || message.icao)) || "";
}

export class MetarClient {
  constructor({
    airports,
    token,
    url = DEFAULT_URL,
    snapshot = true,
    resume = true,
    state = null,
    bbox = null,
    platform = null,
    onRecord = null,
    onFrame = null,
    datis = null,
    datisTypes = null,
    onDatis = null,
    notices = true,
    onFeedNotice = null,
  } = {}) {
    this.url = url;
    this.token = resolveToken(token);
    this.airports = (airports || []).map((name) => String(name).toUpperCase());
    this.snapshot = snapshot;
    this.resume = resume;
    this.onRecord = onRecord;
    this.onFrame = onFrame;
    this.latest = {};
    this.bootId = null;
    this.seq = null;
    this._delay = BACKOFF_START_MS;
    this._stopped = false;
    this._ws = null;
    this._sessionDone = null;
    this.lastUsage = null;
    this.lastLate = null;
    this.lastRecovered = null;
    this.lates = {};
    this.lastError = null;
    this.heldIcaos = this.airports.slice();
    this.states = [];
    this.bboxes = [];
    this.platforms = [];
    this._sessionOpen = false;
    this._grantResumePending = false;
    // 0.18.0: D-ATIS and feed notices.
    this.datis = (datis || []).map((name) => String(name).toUpperCase());
    this.datisTypes = datisTypes && datisTypes.length ? datisTypes.slice() : null;
    this.onDatis = onDatis;
    this.datisLatest = {};
    this.heldDatis = this.datis.slice();
    this.heldDatisTypes = [];
    this.datisSupported = null; // null until the first subscription_updated
    this.noticesEnabled = Boolean(notices);
    this.notices = [];
    this.onFeedNotice = onFeedNotice;
    this._datisTypesPending = false;
    this.fetchLatest = fetchLatest;
    this.fetchDatisLatest = fetchDatisLatest;
    if (state) this.states.push(String(state).toUpperCase());
    if (bbox) this.bboxes.push(Object.assign({}, bbox));
    if (platform) this.platforms.push(String(platform).toLowerCase());
  }

  handshakeUrl() {
    const useResume = this.resume && !this.hasGrants();
    return handshakeUrl(this.url, this.airports, {
      snapshot: this.hasGrants() ? false : this.snapshot,
      sinceSeq: useResume ? this.seq : null,
      bootId: useResume ? this.bootId : null,
      datis: this.datis,
      notices: this.noticesEnabled,
    });
  }

  hasGrants() {
    return this.states.length > 0 || this.bboxes.length > 0 || this.platforms.length > 0;
  }

  handleFrame(message) {
    const kind = message && message.type;
    if (kind === "subscription_updated") {
      if (message.boot_id) this.bootId = message.boot_id;
      if (Array.isArray(message.icaos)) {
        this.heldIcaos = message.icaos.map((item) => String(item).toUpperCase());
      }
      this._noteDatis(message);
      if (this._sessionOpen) this._rememberGrantsFrom(message);
      else if (this.hasGrants()) this._grantResumePending = true;
      this._sessionOpen = true;
      // Do not take seq from subscription_updated: it is the server's
      // current seq, and would skip replay frames not yet received.
    } else if (kind === "error") {
      this.lastError = message;
      // A server that knows D-ATIS but refused it (no datis scope, or the product is off).
      if (message.code === "forbidden" || message.code === "unavailable") this.datisSupported = null;
    } else if (kind === "resume") {
      const metar = this.fetchLatest(this.url, this.token, this.heldIcaos.length ? this.heldIcaos : this.airports);
      const datis = message.datis_fallback && this.heldDatis.length
        ? this.fetchDatisLatest(this.url, this.token, this.heldDatis)
        : Promise.resolve([]);
      return Promise.all([metar, datis]).then(([rows, datisRows]) => {
        for (const rec of rows) {
          const before = this.latest[rec.icao];
          mergeRecord(this.latest, rec, false);
          this._emit(rec.icao, before);
        }
        this._applyDatis(datisRows);
        if (this.onFrame) this.onFrame(message);
      });
    } else if (kind === "new_datis_arrived") {
      this._applyDatis(message.data || []);
      if (message.cached !== true && message.seq != null) this._advanceSeq(message.seq);
    } else if (kind === "feed_notice") {
      this.notices = Array.isArray(message.notices) ? message.notices.slice() : [];
      if (this.onFeedNotice) this.onFeedNotice(this.notices);
    } else if (kind === "new_metar_arrived") {
      const live = message.cached === false && message.replay === false;
      const replayed = message.replay === true;
      for (const rec of message.data || []) {
        const before = this.latest[rec.icao];
        mergeRecord(this.latest, rec, live);
        this._emit(rec.icao, before);
      }
      if ((live || replayed) && message.seq != null) this._advanceSeq(message.seq);
    } else if (kind === "awc_confirmed") {
      if (message.seq != null) this._advanceSeq(message.seq);
      const before = message.icao && this.latest[message.icao]
        ? Object.assign({}, this.latest[message.icao])
        : null;
      applyAwcConfirmed(this.latest, message);
      this._emit(message.icao, before);
    } else if (kind === "station_late" || kind === "station_recovered" || kind === "usage") {
      if (message.seq != null) this._advanceSeq(message.seq);
      if (kind === "usage") this.lastUsage = message;
      else if (kind === "station_late") {
        this.lastLate = message;
        this.lates[outageKey(message)] = message;
      } else {
        this.lastRecovered = message;
        const key = outageKey(message);
        delete this.lates[key];
        if (this.lastLate && outageKey(this.lastLate) === key) this.lastLate = null;
      }
    }
    if (this.onFrame) this.onFrame(message);
  }

  _noteDatis(message) {
    const first = !this._sessionOpen;
    if (Array.isArray(message.datis_icaos)) {
      this.datisSupported = true;
      this.heldDatis = message.datis_icaos.map((item) => String(item).toUpperCase());
      if (Array.isArray(message.datis_types)) this.heldDatisTypes = message.datis_types.map(String);
      // datis_types are subscribe-only: send the wanted types once per socket.
      if (first && this.datisTypes) {
        const want = [...this.datisTypes].sort().join(",");
        const have = [...this.heldDatisTypes].sort().join(",");
        if (want !== have) this._datisTypesPending = true;
      }
    } else if (this.datisSupported === true) {
      this.heldDatis = [];
      this.heldDatisTypes = [];
    } else if (this.datis.length && first) {
      // Asked for D-ATIS and the first answer has no datis_icaos: the server predates v0.44.0.
      // A v0.44.0 server that refuses it follows with forbidden or unavailable, which resets this.
      this.datisSupported = false;
      this.lastError = {type: "error", code: "unsupported", message: DATIS_UNSUPPORTED};
    }
  }

  _applyDatis(rows) {
    for (const rec of rows || []) {
      if (mergeDatis(this.datisLatest, rec) && this.onDatis) this.onDatis(this.datisLatest[datisKey(rec)]);
    }
  }

  _requireDatis() {
    if (this.datisSupported === false) throw new Error(DATIS_UNSUPPORTED);
  }

  /** Add D-ATIS stations mid-session. Throws "server does not support D-ATIS" on an old server. */
  subscribeDatis(icaos, {types = null, snapshot = null} = {}) {
    this._requireDatis();
    const codes = icaos.map((item) => String(item).toUpperCase());
    for (const code of codes) if (!this.datis.includes(code)) this.datis.push(code);
    const fields = {datis: codes};
    if (types != null) {
      fields.datis_types = types.slice();
      this.datisTypes = types.slice();
    }
    if (snapshot != null) fields.snapshot = snapshot;
    const ws = this._ws;
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify(this.subscribeBody(null, fields)));
  }

  /** Drop D-ATIS stations mid-session; METAR stations are untouched. */
  unsubscribeDatis(icaos) {
    this._requireDatis();
    const codes = [...new Set(icaos.map((item) => String(item).toUpperCase()))].sort();
    this.datis = this.datis.filter((code) => !codes.includes(code));
    for (const key of Object.keys(this.datisLatest)) {
      if (codes.includes(key.split("/")[0])) delete this.datisLatest[key];
    }
    const ws = this._ws;
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({action: "unsubscribe", datis: codes}));
  }

  /** Turn feed_notice frames on or off for this socket (and later reconnects). */
  setNotices(enabled) {
    this.noticesEnabled = Boolean(enabled);
    const ws = this._ws;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({action: "subscribe", notices: this.noticesEnabled}));
  }

  _advanceSeq(seq) {
    if (this.seq == null || seq > this.seq) this.seq = seq;
  }

  _emit(icao, before) {
    if (!icao || !this.onRecord) return;
    const held = this.latest[icao];
    if (held && held !== before && JSON.stringify(held) !== JSON.stringify(before)) {
      this.onRecord(held);
    }
  }

  requestUsage() {
    const ws = this._ws;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({action: "usage"}));
    }
  }

  subscribeBody(icaos, fields = {}) {
    const body = {action: "subscribe"};
    if (icaos != null) body.icaos = icaos.map((item) => String(item).toUpperCase());
    if (fields.state != null) body.state = String(fields.state).toUpperCase();
    if (fields.bbox != null) body.bbox = Object.assign({}, fields.bbox);
    if (fields.platform != null) body.platform = String(fields.platform).toLowerCase();
    if (fields.since_seq != null && fields.boot_id) {
      body.since_seq = fields.since_seq;
      body.boot_id = fields.boot_id;
    }
    if (fields.snapshot != null) body.snapshot = Boolean(fields.snapshot);
    for (const [key, value] of Object.entries(fields)) {
      if (!["state", "bbox", "platform", "since_seq", "boot_id", "snapshot"].includes(key)) {
        body[key] = value;
      }
    }
    return body;
  }

  reconnectSubscribeBodies() {
    const states = this.states.slice();
    const bboxes = this.bboxes.slice();
    const platforms = this.platforms.slice();
    const first = this.subscribeBody(this.airports.length ? this.airports : null, {
      state: states.length ? states.shift() : null,
      bbox: bboxes.length ? bboxes.shift() : null,
      platform: platforms.length ? platforms.shift() : null,
      since_seq: this.resume ? this.seq : null,
      boot_id: this.resume ? this.bootId : null,
      snapshot: this.snapshot ? true : null,
    });
    const bodies = [first];
    while (states.length || bboxes.length || platforms.length) {
      bodies.push(this.subscribeBody(null, {
        state: states.length ? states.shift() : null,
        bbox: bboxes.length ? bboxes.shift() : null,
        platform: platforms.length ? platforms.shift() : null,
        snapshot: true,
      }));
    }
    return bodies;
  }

  _rememberGrantsFrom(message) {
    const regions = message.regions || [];
    const platforms = message.platforms || [];
    const states = [];
    const bboxes = [];
    for (const item of regions) {
      const raw = String(item);
      if (raw.toLowerCase().startsWith("state:")) states.push(raw.split(":").slice(1).join(":").toUpperCase());
      else if (raw.toLowerCase().startsWith("bbox:")) {
        const parts = raw.split(":").slice(1).join(":").split(",");
        if (parts.length === 4) {
          const nums = parts.map(Number);
          if (nums.every((n) => Number.isFinite(n))) {
            bboxes.push({south: nums[0], west: nums[1], north: nums[2], east: nums[3]});
          }
        }
      }
    }
    this.states = states;
    this.bboxes = bboxes;
    this.platforms = platforms.map((name) => String(name).toLowerCase());
  }

  _rememberOutgoingGrants(body) {
    if (body.state && !this.states.includes(body.state)) this.states.push(body.state);
    if (body.bbox) this.bboxes.push(Object.assign({}, body.bbox));
    if (body.platform && !this.platforms.includes(body.platform)) this.platforms.push(body.platform);
    if (Array.isArray(body.icaos)) {
      for (const item of body.icaos) {
        const code = String(item).toUpperCase();
        if (!this.airports.includes(code)) this.airports.push(code);
      }
    }
  }

  subscribe(icaos = [], fields = {}) {
    const ws = this._ws;
    if (!ws || ws.readyState !== 1) return;
    const body = this.subscribeBody(icaos, fields);
    this._rememberOutgoingGrants(body);
    ws.send(JSON.stringify(body));
  }

  unsubscribe(icaos = null, fields = {}) {
    const ws = this._ws;
    if (!ws || ws.readyState !== 1) return;
    const body = {action: "unsubscribe"};
    if (icaos != null) body.icaos = icaos.map((item) => String(item).toUpperCase());
    if (fields.state != null) body.state = String(fields.state).toUpperCase();
    if (fields.bbox != null) body.bbox = Object.assign({}, fields.bbox);
    if (fields.platform != null) body.platform = String(fields.platform).toLowerCase();
    for (const [key, value] of Object.entries(fields)) {
      if (!["state", "bbox", "platform"].includes(key)) body[key] = value;
    }
    ws.send(JSON.stringify(body));
  }

  _flushGrantResume() {
    const ws = this._ws;
    if (this._datisTypesPending && ws && ws.readyState === 1) {
      this._datisTypesPending = false;
      ws.send(JSON.stringify({action: "subscribe", datis: this.datis.slice(), datis_types: (this.datisTypes || []).slice()}));
    }
    if (!this._grantResumePending || !ws || ws.readyState !== 1) return;
    this._grantResumePending = false;
    for (const body of this.reconnectSubscribeBodies()) {
      ws.send(JSON.stringify(body));
    }
  }

  stop() {
    this._stopped = true;
    if (this._stopTimer) this._stopTimer();
    const ws = this._ws;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) {
      ws.close(1000, "client stop");
    }
  }

  _session() {
    return new Promise((resolve) => {
      if (this._stopped) {
        resolve(null);
        return;
      }
      let openedAt = null;
      let sawMessage = false;
      let pingTimer = null;
      let pongTimer = null;
      let settled = false;
      const finish = (code) => {
        if (settled) return;
        settled = true;
        if (pingTimer) clearInterval(pingTimer);
        if (pongTimer) clearTimeout(pongTimer);
        this._ws = null;
        if (sawMessage || (openedAt != null && Date.now() - openedAt >= QUIET_OPEN_MS)) {
          this._delay = BACKOFF_START_MS;
        }
        resolve(code == null ? null : code);
      };

      let ws;
      try {
        ws = openWebSocket(this.handshakeUrl(), this.token);
      } catch (err) {
        finish(1006);
        return;
      }
      this._ws = ws;
      this._sessionOpen = false;
      this._grantResumePending = false;
      this._datisTypesPending = false;

      ws.addEventListener("open", () => {
        openedAt = Date.now();
        pingTimer = setInterval(() => {
          if (ws.readyState !== 1) return;
          ws.send(JSON.stringify({action: "ping"}));
          if (pongTimer) clearTimeout(pongTimer);
          pongTimer = setTimeout(() => {
            try { ws.close(1001, "pong timeout"); } catch {}
          }, PONG_TIMEOUT_MS);
        }, PING_EVERY_MS);
      });

      ws.addEventListener("message", (event) => {
        if (!sawMessage) {
          sawMessage = true;
          this._delay = BACKOFF_START_MS;
        }
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === "pong" && pongTimer) {
          clearTimeout(pongTimer);
          pongTimer = null;
        }
        const result = this.handleFrame(message);
        if (result && typeof result.then === "function") result.then(() => this._flushGrantResume());
        else this._flushGrantResume();
      });

      ws.addEventListener("close", (event) => {
        finish(event && event.code != null ? event.code : 1006);
      });

      ws.addEventListener("error", () => {
        // close follows; finish there so the code is accurate
      });
    });
  }

  async runForever() {
    this._stopped = false;
    while (!this._stopped) {
      const code = await this._session();
      if (this._stopped) return;
      if (!shouldRetry(code)) return;
      const wait = this._delay * (0.5 + Math.random());
      this._delay = Math.min(this._delay * 2, BACKOFF_CAP_MS);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, wait);
        this._stopTimer = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this._stopTimer = null;
    }
  }
}

export { MetarClient as MetarExample };
