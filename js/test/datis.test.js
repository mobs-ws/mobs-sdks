// 0.18.0: D-ATIS and feed notices (server v0.44.0+). No MOBS server needed.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DATIS_TYPES,
  DATIS_UNSUPPORTED,
  MetarClient,
  datisLatestUrl,
  handshakeUrl,
  mergeDatis,
} from "../src/index.js";

function rec(letter = "U", issued = "2026-11-19T11:51:00+00:00", revision = 0, extra = {}) {
  return Object.assign({
    icao: "KLGA", type: "combined", letter, issued_at: issued,
    datis_time: issued.slice(8, 10) + issued.slice(11, 13) + issued.slice(14, 16),
    text: "KLGA ATIS INFO " + letter, arrived_at: issued.slice(0, 16) + ":41.205+00:00", source: "swim",
    source_time: issued.slice(0, 16) + ":40.912+00:00", revision,
    versions: `KLGA/combined/${letter}/${issued.slice(0, 16)}Z/${revision}`,
  }, extra);
}

function hello(extra = {}) {
  return Object.assign({type: "subscription_updated", icaos: ["KLGA"], boot_id: "boot", seq: 5, resume: null, replayed: null}, extra);
}

class FakeWs {
  constructor() { this.readyState = 1; this.sent = []; }
  send(text) { this.sent.push(JSON.parse(text)); }
}

test("handshake carries datis and the notices opt-out", () => {
  const url = handshakeUrl("wss://mobs.ws/v1/ws/metar", ["KLGA"], {datis: ["KLGA", "KJFK"], notices: false});
  assert.match(url, /datis=KLGA%2CKJFK/);
  assert.match(url, /notices=false/);
  assert.doesNotMatch(handshakeUrl("wss://mobs.ws/v1/ws/metar", ["KLGA"]), /datis=|notices=/);
  const client = new MetarClient({token: "YOUR_API_KEY", airports: ["klga"], datis: ["klga"]});
  assert.match(client.handshakeUrl(), /datis=KLGA/);
  assert.equal(datisLatestUrl("wss://mobs.ws/v1/ws/metar", ["KLGA"]), "https://mobs.ws/v1/datis/latest?airports=KLGA");
  assert.deepEqual([...DATIS_TYPES], ["combined", "arr", "dep"]);
});

test("merge keeps the newest issue, then revision", () => {
  const latest = {};
  assert.equal(mergeDatis(latest, rec("U")), true);
  assert.equal(mergeDatis(latest, rec("U")), false);
  assert.equal(mergeDatis(latest, rec("U", undefined, 1)), true);
  assert.equal(mergeDatis(latest, rec("U")), false);
  assert.equal(mergeDatis(latest, rec("V", "2026-11-19T12:51:00+00:00")), true);
  assert.equal(mergeDatis(latest, rec("U", undefined, 2)), false);
  assert.equal(latest["KLGA/combined"].letter, "V");
});

test("frames feed onDatis, seq and onFeedNotice", () => {
  const seen = [];
  const notices = [];
  const client = new MetarClient({token: "YOUR_API_KEY", airports: ["KLGA"], datis: ["KLGA"],
    onDatis: (r) => seen.push(r.letter), onFeedNotice: (n) => notices.push(n)});
  client.handleFrame(hello({datis_icaos: ["KLGA"], datis_types: ["combined", "arr", "dep"]}));
  assert.equal(client.datisSupported, true);
  client.handleFrame({type: "new_datis_arrived", cached: true, replay: false, seq: 5, data: [rec()]});
  assert.equal(client.seq, null);
  client.handleFrame({type: "new_datis_arrived", cached: false, replay: false, seq: 6, backlog: true,
    data: [rec("V", "2026-11-19T12:51:00+00:00")]});
  assert.equal(client.seq, 6);
  assert.deepEqual(seen, ["U", "V"]);
  const entry = {id: "n1", feed: "datis", source: "swim", icaos: null, kind: "outage", message: "SWIM down",
    starts_at: "2026-11-19T06:00:00.000Z", ends_at: null, posted_at: "2026-11-19T06:05:00.000Z", posted_by: "auto"};
  client.handleFrame({type: "feed_notice", notices: [entry]});
  client.handleFrame({type: "feed_notice", notices: []});
  assert.deepEqual(notices, [[entry], []]);
  assert.deepEqual(client.notices, []);
});

test("an old server is reported; forbidden or unavailable is not", () => {
  const client = new MetarClient({token: "YOUR_API_KEY", airports: ["KLGA"], datis: ["KLGA"]});
  client.handleFrame(hello());
  assert.equal(client.datisSupported, false);
  assert.deepEqual(client.lastError, {type: "error", code: "unsupported", message: DATIS_UNSUPPORTED});
  assert.throws(() => client.subscribeDatis(["KJFK"]), new RegExp(DATIS_UNSUPPORTED));
  for (const code of ["forbidden", "unavailable"]) {
    const other = new MetarClient({token: "YOUR_API_KEY", airports: ["KLGA"], datis: ["KLGA"]});
    other.handleFrame(hello());
    other.handleFrame({type: "error", code, message: code});
    assert.equal(other.datisSupported, null);
  }
});

test("resume fallback refetches D-ATIS", async () => {
  const client = new MetarClient({token: "YOUR_API_KEY", airports: ["KLGA"], datis: ["KLGA"]});
  const calls = [];
  client.fetchLatest = async (url, token, icaos) => { calls.push(["metar", icaos]); return []; };
  client.fetchDatisLatest = async (url, token, icaos) => { calls.push(["datis", icaos]); return [rec()]; };
  client.handleFrame(hello({datis_icaos: ["KLGA"], datis_types: ["combined", "arr", "dep"]}));
  await client.handleFrame({type: "resume", reason: "boot_id", fallback: "/v1/metar/latest", datis_fallback: "/v1/datis/latest"});
  assert.deepEqual(calls, [["metar", ["KLGA"]], ["datis", ["KLGA"]]]);
  assert.equal(client.datisLatest["KLGA/combined"].letter, "U");
  calls.length = 0;
  await client.handleFrame({type: "resume", reason: "boot_id", fallback: "/v1/metar/latest"});
  assert.deepEqual(calls, [["metar", ["KLGA"]]]);
});

test("wire bodies: wanted types, subscribe, unsubscribe, notices", () => {
  const client = new MetarClient({token: "YOUR_API_KEY", airports: ["KLGA"], datis: ["KLGA"], datisTypes: ["combined"], notices: false});
  assert.match(client.handshakeUrl(), /notices=false/);
  const ws = new FakeWs();
  client._ws = ws;
  client.handleFrame(hello({datis_icaos: ["KLGA"], datis_types: ["combined", "arr", "dep"]}));
  client._flushGrantResume();
  client.subscribeDatis(["kjfk"], {types: ["combined", "arr"]});
  client.unsubscribeDatis(["KJFK"]);
  client.setNotices(true);
  assert.deepEqual(ws.sent, [
    {action: "subscribe", datis: ["KLGA"], datis_types: ["combined"]},
    {action: "subscribe", datis: ["KJFK"], datis_types: ["combined", "arr"]},
    {action: "unsubscribe", datis: ["KJFK"]},
    {action: "subscribe", notices: true},
  ]);
  assert.deepEqual(client.datis, ["KLGA"]);
});

// 0.18.1: amended (server v0.46.0+) and the real record time shapes.
test("amended passes through merge and onDatis, absent when the server omits it", () => {
  const seen = [];
  const client = new MetarClient({token: "YOUR_API_KEY", airports: ["KLGA"], datis: ["KLGA"], onDatis: (r) => seen.push(r)});
  client.handleFrame(hello({datis_icaos: ["KLGA"], datis_types: ["combined", "arr", "dep"]}));
  client.handleFrame({type: "new_datis_arrived", cached: false, replay: false, seq: 6, data: [rec("O")]});
  client.handleFrame({type: "new_datis_arrived", cached: false, replay: false, seq: 7, data: [rec("P", undefined, 0, {amended: true})]});
  assert.deepEqual(seen.map((r) => [r.letter, r.amended]), [["O", undefined], ["P", true]]);
  assert.equal("amended" in seen[0], false);
  const held = client.datisLatest["KLGA/combined"];
  assert.equal(held.letter, "P");
  assert.equal(held.amended, true);
  // Round trip: the held record is the server object, field order included, amended last.
  const wire = rec("P", undefined, 0, {amended: true});
  assert.deepEqual(JSON.parse(JSON.stringify(held)), wire);
  assert.deepEqual(Object.keys(held), ["icao", "type", "letter", "issued_at", "datis_time", "text", "arrived_at",
    "source", "source_time", "revision", "versions", "amended"]);
});

test("same issued_at, new letter, revision 0 (an amendment) replaces the held record", () => {
  const latest = {};
  assert.equal(mergeDatis(latest, rec("O")), true);
  assert.equal(mergeDatis(latest, rec("P", undefined, 0, {amended: true})), true);
  assert.equal(latest["KLGA/combined"].letter, "P");
  assert.equal(mergeDatis(latest, rec("P", undefined, 0, {amended: true})), false);  // same versions
});

test("record time shapes: +00:00, issued_at without milliseconds", () => {
  const r = rec();
  assert.match(r.issued_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+00:00$/);
  assert.match(r.arrived_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/);
  assert.match(r.source_time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/);
  assert.equal(r.datis_time, "191151");
});
