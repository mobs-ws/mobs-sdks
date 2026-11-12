"""Self-contained unit tests for the mobs-ws Python client (no MOBS server needed)."""
from __future__ import annotations

import asyncio
import socket
import tomllib
from pathlib import Path

import pytest

import mobs_ws
from mobs_ws import (
    MetarClient,
    apply_awc_confirmed,
    handshake_url,
    latest_url,
    merge_record,
    resolve_token,
    should_retry,
)

PKG = Path(__file__).resolve().parent.parent


def test_metadata_is_publish_ready():
    data = tomllib.loads((PKG / "pyproject.toml").read_text())
    project = data["project"]
    assert project["name"] == "mobs-ws"
    assert project["version"] == mobs_ws.__version__
    assert project["dependencies"] == ["websockets>=17.3"]
    assert project["license"] == "MIT"
    assert project["urls"]["Repository"] == "https://github.com/mobs-ws/mobs-sdks"
    assert (PKG / "LICENSE").is_file()


def test_token_comes_from_caller_or_env(monkeypatch):
    monkeypatch.delenv("MOBS_TOKEN", raising=False)
    with pytest.raises(ValueError, match="MOBS_TOKEN"):
        resolve_token(None)
    with pytest.raises(ValueError, match="MOBS_TOKEN"):
        resolve_token("")
    monkeypatch.setenv("MOBS_TOKEN", "from-env")
    assert resolve_token(None) == "from-env"
    assert resolve_token("from-caller") == "from-caller"


def test_merge_confirm_and_unknown_types():
    latest = {}
    merge_record(latest, {"icao": "KNYC", "versions": "v0", "obs_time": "t", "raw_metar": "A"}, live=False)
    assert latest["KNYC"]["raw_metar"] == "A"
    merge_record(latest, {"icao": "KNYC", "versions": "v1", "obs_time": "t", "raw_metar": "B"}, live=True)
    assert latest["KNYC"]["raw_metar"] == "B"
    apply_awc_confirmed(latest, {"icao": "KNYC", "versions": "v1", "awc_confirmed_at": "t1"})
    assert latest["KNYC"]["awc_confirmed"] is True and latest["KNYC"]["awc_confirmed_at"] == "t1"
    apply_awc_confirmed(latest, {"icao": "KNYC", "versions": "v1", "awc_confirmed_at": "t2"})
    assert latest["KNYC"]["awc_confirmed_at"] == "t2"
    apply_awc_confirmed(latest, {"icao": "KNYC", "versions": "v9", "awc_confirmed_at": "nope"})
    assert latest["KNYC"]["awc_confirmed_at"] == "t2"
    client = MetarClient(["KNYC"], token="YOUR_API_KEY", url="ws://127.0.0.1:9/v1/ws/metar")
    client.latest = latest
    client.handle_frame({"type": "not_a_real_type", "seq": 99})
    assert latest["KNYC"]["awc_confirmed_at"] == "t2"
    assert should_retry(4008) and not should_retry(4403)
    url = handshake_url("wss://mobs.ws/v1/ws/metar", ["KNYC"], snapshot=True, since_seq=4, boot_id="abcd")
    assert "snapshot=true" in url and "since_seq=4" in url and "boot_id=abcd" in url
    assert latest_url("wss://mobs.ws/v1/ws/metar", ["KNYC"]).startswith("https://mobs.ws/v1/metar/latest")


def test_seq_advances_only_from_received_replay_or_live():
    client = MetarClient(["KNYC"], token="YOUR_API_KEY", url="ws://127.0.0.1:9/v1/ws/metar")
    client.seq = 2
    client.handle_frame(
        {"type": "subscription_updated", "icaos": ["KNYC"], "boot_id": "boot", "seq": 80, "resume": "full", "replayed": 80}
    )
    assert client.boot_id == "boot"
    assert client.seq == 2
    rec = {"icao": "KNYC", "versions": "v1", "obs_time": "t", "raw_metar": "A"}
    client.handle_frame({"type": "new_metar_arrived", "cached": False, "replay": True, "seq": 5, "data": [rec]})
    assert client.seq == 5
    client.handle_frame({"type": "new_metar_arrived", "cached": True, "replay": False, "seq": 80, "data": [rec]})
    assert client.seq == 5
    client.handle_frame({"type": "new_metar_arrived", "cached": False, "replay": False, "seq": 6, "data": [rec]})
    assert client.seq == 6
    client.handle_frame({"type": "awc_confirmed", "icao": "KNYC", "versions": "v1", "awc_confirmed_at": "t", "seq": 7})
    assert client.seq == 7


def _closed_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


async def _http_status_server(status: int):
    async def handler(reader, writer):
        try:
            await asyncio.wait_for(reader.read(4096), timeout=1)
        except Exception:
            pass
        try:
            writer.write(f"HTTP/1.1 {status} test\r\nConnection: close\r\n\r\n".encode())
            await writer.drain()
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass

    server = await asyncio.start_server(handler, "127.0.0.1", 0)
    return server, server.sockets[0].getsockname()[1]


async def _run_counted(client: MetarClient, n: int, timeout: float = 5) -> list[int | None]:
    codes: list[int | None] = []
    original = MetarClient._session

    async def wrapped(_self=client):
        code = await original(_self)
        codes.append(code)
        if len(codes) >= n:
            _self.stop()
        return code

    client._session = wrapped  # type: ignore[method-assign]
    client._delay = 0.01
    await asyncio.wait_for(client.run_forever(), timeout=timeout)
    return codes


def _client(url: str) -> MetarClient:
    return MetarClient(["KNYC"], token="local-test-token", url=url, snapshot=False, resume=False)


def test_connect_refused_502_and_401_do_not_escape_run_forever():
    async def run():
        codes = await _run_counted(_client(f"ws://127.0.0.1:{_closed_port()}/v1/ws/metar"), 2)
        assert codes[0] == 1006 and len(codes) >= 2

        server, port = await _http_status_server(502)
        try:
            codes = await _run_counted(_client(f"ws://127.0.0.1:{port}/v1/ws/metar"), 2)
            assert codes[0] == 1006 and len(codes) >= 2
        finally:
            server.close()
            await server.wait_closed()

        server, port = await _http_status_server(401)
        try:
            codes = await _run_counted(_client(f"ws://127.0.0.1:{port}/v1/ws/metar"), 2)
            assert codes == [4403]
        finally:
            server.close()
            await server.wait_closed()

    asyncio.run(run())


def test_connect_asyncio_timeout_backs_off(monkeypatch):
    class _Boom:
        async def __aenter__(self):
            raise asyncio.TimeoutError()

        async def __aexit__(self, *_exc):
            return None

    monkeypatch.setattr("mobs_ws.client.connect", lambda *_a, **_k: _Boom())

    async def run():
        codes = await _run_counted(_client("ws://127.0.0.1:9/v1/ws/metar"), 2)
        assert codes[0] == 1006 and len(codes) >= 2

    asyncio.run(run())
