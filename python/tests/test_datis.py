"""0.18.0: D-ATIS and feed notices (server v0.44.0+). No MOBS server needed."""
from __future__ import annotations

import asyncio
import json

import pytest
from websockets.asyncio.server import serve

from mobs_ws import (
    DATIS_UNSUPPORTED,
    DatisRecord,
    MetarClient,
    datis_latest_url,
    handshake_url,
    merge_datis,
)


def _rec(letter="U", issued="2026-11-19T11:51:00.000Z", revision=0, text="KLGA ATIS INFO U", **extra):
    hhmm = issued[11:13] + issued[14:16]
    rec = {
        "icao": "KLGA",
        "type": "combined",
        "letter": letter,
        "issued_at": issued,
        "datis_time": hhmm,
        "text": text,
        "arrived_at": issued,
        "source": "swim",
        "source_time": issued,
        "revision": revision,
        "versions": f"KLGA/combined/{letter}/{issued[:16]}Z/{revision}",
    }
    rec.update(extra)
    return rec


def _hello(**extra):
    body = {"type": "subscription_updated", "icaos": ["KLGA"], "boot_id": "boot", "seq": 5, "resume": None, "replayed": None}
    body.update(extra)
    return body


def test_handshake_url_carries_datis_and_notices_opt_out():
    url = handshake_url("wss://mobs.ws/v1/ws/metar", ["KLGA"], datis=["KLGA", "KJFK"], notices=False)
    assert "datis=KLGA%2CKJFK" in url and "notices=false" in url
    plain = handshake_url("wss://mobs.ws/v1/ws/metar", ["KLGA"])
    assert "datis=" not in plain and "notices=" not in plain
    client = MetarClient(["klga"], token="YOUR_API_KEY", datis=["klga"])
    assert "datis=KLGA" in client.handshake_url()
    assert datis_latest_url("wss://mobs.ws/v1/ws/metar", ["KLGA"]) == "https://mobs.ws/v1/datis/latest?airports=KLGA"


def test_merge_keeps_newest_issue_then_revision():
    latest: dict = {}
    assert merge_datis(latest, _rec("U"))
    assert not merge_datis(latest, _rec("U"))  # same versions
    assert merge_datis(latest, _rec("U", revision=1, text="KLGA ATIS INFO U RWY 22"))
    assert not merge_datis(latest, _rec("U"))  # older revision (late snapshot)
    assert merge_datis(latest, _rec("V", issued="2026-11-19T12:51:00.000Z"))
    assert not merge_datis(latest, _rec("U", revision=2))  # older issue
    assert latest[("KLGA", "combined")]["letter"] == "V"
    rec = DatisRecord.from_dict(latest[("KLGA", "combined")])
    assert rec.letter == "V" and rec.revision == 0 and rec.versions.endswith("/0")


def test_frames_feed_on_datis_seq_and_notices():
    seen, notices = [], []
    client = MetarClient(["KLGA"], token="YOUR_API_KEY", datis=["KLGA"], on_datis=seen.append, on_feed_notice=notices.append)
    client.handle_frame(_hello(datis_icaos=["KLGA"], datis_types=["combined", "arr", "dep"]))
    assert client.datis_supported is True and client.held_datis == ["KLGA"]
    client.handle_frame({"type": "new_datis_arrived", "cached": True, "replay": False, "seq": 5, "data": [_rec()]})
    assert client.seq is None  # snapshots never advance seq
    client.handle_frame({"type": "new_datis_arrived", "cached": False, "replay": False, "seq": 6, "backlog": True,
                         "data": [_rec("V", issued="2026-11-19T12:51:00.000Z")]})
    assert client.seq == 6
    assert [r["letter"] for r in seen] == ["U", "V"]
    entry = {"id": "n1", "feed": "datis", "source": "swim", "icaos": None, "kind": "outage", "message": "SWIM down",
             "starts_at": "2026-11-19T06:00:00.000Z", "ends_at": None, "posted_at": "2026-11-19T06:05:00.000Z", "posted_by": "auto"}
    client.handle_frame({"type": "feed_notice", "notices": [entry]})
    client.handle_frame({"type": "feed_notice", "notices": []})
    assert notices == [[entry], []] and client.notices == []


def test_old_server_is_reported_and_metar_keeps_working():
    client = MetarClient(["KLGA"], token="YOUR_API_KEY", datis=["KLGA"])
    client.handle_frame(_hello())
    assert client.datis_supported is False
    assert client.last_error == {"type": "error", "code": "unsupported", "message": DATIS_UNSUPPORTED}
    with pytest.raises(RuntimeError, match=DATIS_UNSUPPORTED):
        asyncio.run(client.subscribe_datis(["KJFK"]))
    client.handle_frame({"type": "new_metar_arrived", "cached": False, "replay": False, "seq": 6,
                         "data": [{"icao": "KLGA", "versions": "v", "obs_time": "t", "raw_metar": "METAR KLGA"}]})
    assert client.latest["KLGA"]["raw_metar"] == "METAR KLGA"


def test_forbidden_or_unavailable_is_not_an_old_server():
    for code in ("forbidden", "unavailable"):
        client = MetarClient(["KLGA"], token="YOUR_API_KEY", datis=["KLGA"])
        client.handle_frame(_hello())
        client.handle_frame({"type": "error", "code": code, "message": code})
        assert client.datis_supported is None and client.last_error["code"] == code


def test_resume_fallback_refetches_datis():
    client = MetarClient(["KLGA"], token="YOUR_API_KEY", datis=["KLGA"])
    calls = []
    client.fetch_latest = lambda url, token, icaos: calls.append(("metar", icaos)) or []
    client.fetch_datis_latest = lambda url, token, icaos: calls.append(("datis", icaos)) or [_rec()]
    client.handle_frame(_hello(datis_icaos=["KLGA"], datis_types=["combined", "arr", "dep"]))
    client.handle_frame({"type": "resume", "reason": "boot_id", "fallback": "/v1/metar/latest", "datis_fallback": "/v1/datis/latest"})
    assert calls == [("metar", ["KLGA"]), ("datis", ["KLGA"])]
    assert client.datis_latest[("KLGA", "combined")]["letter"] == "U"
    calls.clear()
    client.handle_frame({"type": "resume", "reason": "boot_id", "fallback": "/v1/metar/latest"})
    assert calls == [("metar", ["KLGA"])]


def test_live_socket_subscribe_unsubscribe_types_and_notices():
    received: list[dict] = []

    async def handler(ws):
        assert "datis=KLGA" in ws.request.path and "notices=false" in ws.request.path
        await ws.send(json.dumps(_hello(datis_icaos=["KLGA"], datis_types=["combined", "arr", "dep"])))
        await ws.send(json.dumps({"type": "new_datis_arrived", "cached": True, "replay": False, "seq": 5, "data": [_rec()]}))
        async for text in ws:
            msg = json.loads(text)
            if msg.get("action") == "ping":
                continue
            received.append(msg)
            if len(received) == 4:
                await ws.close()

    async def run():
        async with serve(handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = MetarClient(["KLGA"], token="YOUR_API_KEY", url=f"ws://127.0.0.1:{port}/v1/ws/metar",
                                 datis=["KLGA"], datis_types=["combined"], notices=False, snapshot=False, resume=False)
            got = asyncio.Event()
            client.on_datis = lambda rec: got.set()
            task = asyncio.create_task(client._session())
            await asyncio.wait_for(got.wait(), 5)
            await client.subscribe_datis(["kjfk"], types=["combined", "arr"])
            await client.unsubscribe_datis(["KJFK"])
            await client.set_notices(True)
            await asyncio.wait_for(task, 5)
            return client

    client = asyncio.run(run())
    assert received == [
        {"action": "subscribe", "datis": ["KLGA"], "datis_types": ["combined"]},
        {"action": "subscribe", "datis": ["KJFK"], "datis_types": ["combined", "arr"]},
        {"action": "unsubscribe", "datis": ["KJFK"]},
        {"action": "subscribe", "notices": True},
    ]
    assert client.datis == ["KLGA"] and client.notices_enabled is True
