// Self-contained unit tests for the mobs-ws JS client (node:test, no dependencies).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

import {
  MetarClient,
  applyAwcConfirmed,
  handshakeUrl,
  latestUrl,
  mergeRecord,
  resolveToken,
  shouldRetry,
} from "../src/index.js";

const pkgUrl = new URL("../package.json", import.meta.url);

test("package metadata is publish-ready", () => {
  const pkg = JSON.parse(readFileSync(pkgUrl, "utf8"));
  assert.equal(pkg.name, "mobs-ws");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.repository.url, "git+https://github.com/mobs-ws/mobs-sdks.git");
  assert.equal(pkg.repository.directory, "js");
  assert.equal(pkg.dependencies, undefined);
  assert.ok(existsSync(new URL("../LICENSE", import.meta.url)));
});

test("token comes from caller or MOBS_TOKEN", () => {
  const saved = process.env.MOBS_TOKEN;
  try {
    delete process.env.MOBS_TOKEN;
    assert.throws(() => resolveToken(null), /MOBS_TOKEN/);
    assert.throws(() => resolveToken(""), /MOBS_TOKEN/);
    process.env.MOBS_TOKEN = "from-env";
    assert.equal(resolveToken(null), "from-env");
    assert.equal(resolveToken("from-caller"), "from-caller");
  } finally {
    if (saved === undefined) delete process.env.MOBS_TOKEN;
    else process.env.MOBS_TOKEN = saved;
  }
});

test("merge, confirm last-wins, unknown frames, URLs", () => {
  const latest = {};
  mergeRecord(latest, {icao: "KNYC", versions: "v0", obs_time: "t", raw_metar: "A"}, false);
  assert.equal(latest.KNYC.raw_metar, "A");
  mergeRecord(latest, {icao: "KNYC", versions: "v1", obs_time: "t", raw_metar: "B"}, true);
  assert.equal(latest.KNYC.raw_metar, "B");
  applyAwcConfirmed(latest, {icao: "KNYC", versions: "v1", awc_confirmed_at: "t1"});
  assert.equal(latest.KNYC.awc_confirmed, true);
  applyAwcConfirmed(latest, {icao: "KNYC", versions: "v1", awc_confirmed_at: "t2"});
  applyAwcConfirmed(latest, {icao: "KNYC", versions: "v9", awc_confirmed_at: "nope"});
  assert.equal(latest.KNYC.awc_confirmed_at, "t2");
  const client = new MetarClient({url: "ws://127.0.0.1:9/v1/ws/metar", token: "YOUR_API_KEY", airports: ["KNYC"]});
  client.latest = latest;
  client.handleFrame({type: "not_a_real_type", seq: 99});
  assert.equal(latest.KNYC.awc_confirmed_at, "t2");
  assert.ok(shouldRetry(4008) && !shouldRetry(4403));
  const url = handshakeUrl("wss://mobs.ws/v1/ws/metar", ["KNYC"], {snapshot: true, sinceSeq: 4, bootId: "abcd"});
  assert.match(url, /snapshot=true/);
  assert.match(url, /since_seq=4/);
  assert.match(url, /boot_id=abcd/);
  assert.ok(latestUrl("wss://mobs.ws/v1/ws/metar", ["KNYC"]).startsWith("https://mobs.ws/v1/metar/latest"));
});

test("seq advances only from received replay or live frames", () => {
  const client = new MetarClient({url: "ws://127.0.0.1:9/v1/ws/metar", token: "YOUR_API_KEY", airports: ["KNYC"]});
  client.seq = 2;
  client.handleFrame({type: "subscription_updated", icaos: ["KNYC"], boot_id: "boot", seq: 80, resume: "full", replayed: 80});
  assert.equal(client.bootId, "boot");
  assert.equal(client.seq, 2);
  const rec = {icao: "KNYC", versions: "v1", obs_time: "t", raw_metar: "A"};
  client.handleFrame({type: "new_metar_arrived", cached: false, replay: true, seq: 5, data: [rec]});
  assert.equal(client.seq, 5);
  client.handleFrame({type: "new_metar_arrived", cached: true, replay: false, seq: 80, data: [rec]});
  assert.equal(client.seq, 5);
  client.handleFrame({type: "new_metar_arrived", cached: false, replay: false, seq: 6, data: [rec]});
  assert.equal(client.seq, 6);
  client.handleFrame({type: "awc_confirmed", icao: "KNYC", versions: "v1", awc_confirmed_at: "t", seq: 7});
  assert.equal(client.seq, 7);
});

test("late alerts are tracked per outage and cleared on recovery", () => {
  const client = new MetarClient({url: "ws://127.0.0.1:9/v1/ws/metar", token: "YOUR_API_KEY", airports: ["KLGA"]});
  const base = {icao: "KLGA", outage_id: "KLGA:2026-11-12T13:51:00Z", down_since: "2026-11-12T13:51:00Z"};
  client.handleFrame({type: "station_late", seq: 10, missed_count: 1, ...base});
  client.handleFrame({type: "station_late", seq: 11, missed_count: 2, ...base});
  assert.equal(Object.keys(client.lates).length, 1);
  assert.equal(client.lastLate.missed_count, 2);
  client.handleFrame({type: "station_recovered", seq: 12, missed_count: 2, ...base});
  assert.equal(Object.keys(client.lates).length, 0);
  assert.equal(client.lastLate, null);
  assert.equal(client.seq, 12);
});

test("version is 0.17.0 and new error codes are exported", async () => {
  const { readFileSync } = await import("node:fs");
  const { MAX_GRANTS, ERROR_CODES, KNOWN_PLATFORMS } = await import("../src/index.js");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.version, "0.17.0");
  assert.equal(MAX_GRANTS, 10);
  assert.ok(ERROR_CODES.includes("invalid_region"));
  assert.ok(ERROR_CODES.includes("unknown_platform"));
  assert.ok(ERROR_CODES.includes("too_many_grants"));
  assert.deepEqual([...KNOWN_PLATFORMS], ["polymarket_com", "polymarket_us"]);
});

test("subscribe body matches the v0.17.0 wire format", () => {
  const client = new MetarClient({token: "YOUR_API_KEY", airports: ["klga"]});
  const box = {south: 40.0, west: -75.0, north: 41.5, east: -73.0};
  const body = client.subscribeBody(["klga"], {
    state: "ny",
    bbox: box,
    platform: "POLYMARKET_COM",
    snapshot: true,
    filter: {speci: true},
  });
  assert.deepEqual(body, {
    action: "subscribe",
    icaos: ["KLGA"],
    state: "NY",
    bbox: box,
    platform: "polymarket_com",
    snapshot: true,
    filter: {speci: true},
  });
});

test("grant reconnect sends since_seq and grants, not on the handshake", () => {
  const client = new MetarClient({
    token: "YOUR_API_KEY",
    airports: [],
    platform: "polymarket_com",
    state: "NY",
    snapshot: true,
    resume: true,
  });
  assert.equal(client.hasGrants(), true);
  const url = client.handshakeUrl();
  assert.doesNotMatch(url, /since_seq=/);
  assert.doesNotMatch(url, /boot_id=/);
  client.seq = 12;
  client.bootId = "boot";
  const bodies = client.reconnectSubscribeBodies();
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].action, "subscribe");
  assert.equal(bodies[0].state, "NY");
  assert.equal(bodies[0].platform, "polymarket_com");
  assert.equal(bodies[0].since_seq, 12);
  assert.equal(bodies[0].boot_id, "boot");
  assert.equal(bodies[0].snapshot, true);
});

test("cached snapshots merge without advancing seq; errors are recorded", () => {
  const client = new MetarClient({token: "YOUR_API_KEY", airports: [], platform: "polymarket_us"});
  const rec = {icao: "KNYC", versions: "v1", obs_time: "t", raw_metar: "A"};
  client.handleFrame({type: "new_metar_arrived", cached: true, replay: false, seq: 80, data: [rec]});
  assert.equal(client.latest.KNYC.raw_metar, "A");
  assert.equal(client.seq, null);
  for (const code of ["invalid_region", "unknown_platform", "too_many_grants"]) {
    client.handleFrame({type: "error", code, message: code});
    assert.equal(client.lastError.code, code);
  }
  client.handleFrame({type: "subscription_updated", icaos: [], boot_id: "boot", seq: 1, resume: null, replayed: null});
  assert.equal(client._grantResumePending, true);
  assert.deepEqual(client.platforms, ["polymarket_us"]);
  client.handleFrame({
    type: "subscription_updated",
    icaos: ["KNYC", "KSFO", "KMIA", "KMDW", "KLAX"],
    platforms: ["polymarket_us"],
    boot_id: "boot",
    seq: 1,
    resume: "full",
    replayed: 4,
  });
  assert.deepEqual(client.heldIcaos, ["KNYC", "KSFO", "KMIA", "KMDW", "KLAX"]);
  assert.deepEqual(client.platforms, ["polymarket_us"]);
  assert.equal(client.seq, null);
});
