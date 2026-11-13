// Official client for MOBS /v1/ws/metar (protocol 4).
// Promoted from examples/ws_client.js and the WebSocket API page sample.
// No runtime dependencies: uses the global WebSocket (browser and Node 22+).
// The token comes only from the caller or the MOBS_TOKEN environment
// variable. It is never embedded.

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
]);
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

export function handshakeUrl(base, airports, {snapshot = true, sinceSeq = null, bootId = null} = {}) {
  const url = new URL(base);
  url.searchParams.set("airports", airports.join(","));
  if (snapshot) url.searchParams.set("snapshot", "true");
  if (sinceSeq != null && bootId) {
    url.searchParams.set("since_seq", String(sinceSeq));
    url.searchParams.set("boot_id", bootId);
  }
  return url.toString();
}

export function latestUrl(wsUrl, airports) {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" || url.protocol === "https:" ? "https:" : "http:";
  url.pathname = "/v1/metar/latest";
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
      if (this._sessionOpen) this._rememberGrantsFrom(message);
      else if (this.hasGrants()) this._grantResumePending = true;
      this._sessionOpen = true;
      // Do not take seq from subscription_updated: it is the server's
      // current seq, and would skip replay frames not yet received.
    } else if (kind === "error") {
      this.lastError = message;
    } else if (kind === "resume") {
      return fetchLatest(this.url, this.token, this.heldIcaos.length ? this.heldIcaos : this.airports).then((rows) => {
        for (const rec of rows) {
          const before = this.latest[rec.icao];
          mergeRecord(this.latest, rec, false);
          this._emit(rec.icao, before);
        }
        if (this.onFrame) this.onFrame(message);
      });
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
