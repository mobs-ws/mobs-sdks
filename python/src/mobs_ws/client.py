"""Official client for MOBS /v1/ws/metar (protocol 4).

Promoted from examples/ws_client.py. Uses the ``websockets`` package
only. HTTP backfill uses urllib from the standard library.

Features: JSON ping every 20 s, 15 s pong timeout, exponential backoff
with jitter (reset after the first message or about 10 s of an open
socket; the 10 s timer starts when the socket opens), opt-in snapshot
and resume with since_seq and boot_id, GET /v1/metar/latest on a resume
fallback (boot_id change, partial, or none), dedupe on icao+versions
plus icao+obs_time+raw_metar, awc_confirmed last-wins per
(icao, versions), station_late / station_recovered / usage
handled (seq advances; usage is a point-in-time read), and
unknown frame types ignored. Filter and delta are opt-in on a
mid-session subscribe, not on the handshake query. Region (`state`,
`bbox`) and platform (`polymarket_com`, `polymarket_us`) grants are
also mid-session only. A socket may hold at most 10 grants;
`invalid_region`, `unknown_platform`, and `too_many_grants` are
exposed on last_error. Snapshot frames are marked cached. On
reconnect, grants are re-subscribed with since_seq and boot_id so
grant stations can be replayed (they cannot go on the handshake query).

The token comes only from the caller or the MOBS_TOKEN environment
variable. It is never embedded.
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from typing import Any

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

DEFAULT_URL = "wss://mobs.ws/v1/ws/metar"
MAX_GRANTS = 10
KNOWN_PLATFORMS = frozenset({"polymarket_com", "polymarket_us"})
ERROR_CODES = frozenset(
    {
        "invalid_airports",
        "bad_request",
        "unknown_action",
        "too_many_airports",
        "invalid_region",
        "unknown_platform",
        "too_many_grants",
    }
)
PING_EVERY_S = 20.0
PONG_TIMEOUT_S = 15.0
BACKOFF_START_S = 1.0
BACKOFF_CAP_S = 30.0
QUIET_OPEN_S = 10.0


def resolve_token(token: str | None = None) -> str:
    """Return the caller-supplied token, or MOBS_TOKEN from the environment."""
    value = token if token not in (None, "") else os.environ.get("MOBS_TOKEN") or ""
    if not value:
        raise ValueError("pass a token or set MOBS_TOKEN")
    return value


def next_backoff(delay: float, *, rand: Callable[[], float] = random.random) -> float:
    """Double, cap at about 30 s, then apply jitter (about 15-45 s at the cap)."""
    grown = min(delay * 2.0, BACKOFF_CAP_S)
    return grown * (0.5 + rand())


def should_retry(code: int | None) -> bool:
    return code != 4403


def _invalid_status_code(exc: InvalidStatus) -> int | None:
    response = getattr(exc, "response", None)
    return getattr(response, "status_code", None)


def connect_failure_code(exc: BaseException) -> int:
    """Map a failed connect to a close code: 401/403 -> 4403 (stop), else 1006."""
    if isinstance(exc, InvalidStatus) and _invalid_status_code(exc) in {401, 403}:
        return 4403
    return 1006


def newer_than(incoming: dict, held: dict) -> bool:
    """Live (or any newer versions / later body) wins over a cached or older record."""
    if incoming.get("versions") != held.get("versions"):
        return True
    if (incoming.get("icao"), incoming.get("obs_time"), incoming.get("raw_metar")) != (
        held.get("icao"),
        held.get("obs_time"),
        held.get("raw_metar"),
    ):
        return True
    return incoming.get("_live", False) and not held.get("_live", False)


def merge_record(latest: dict[str, dict], record: dict, *, live: bool = False) -> dict:
    """Dedupe on icao+versions; icao+obs_time+raw_metar is the body identity."""
    item = dict(record)
    item["_live"] = live
    icao = item.get("icao")
    if not icao:
        return latest
    held = latest.get(icao)
    if held is None or newer_than(item, held):
        latest[icao] = item
    return latest


def apply_awc_confirmed(latest: dict[str, dict], message: dict) -> dict:
    """Last-wins per (icao, versions). Ignore a versions the client never saw."""
    icao = message.get("icao")
    versions = message.get("versions")
    if not icao or versions is None:
        return latest
    held = latest.get(icao)
    if held is None or held.get("versions") != versions:
        return latest
    held["awc_confirmed"] = True
    held["awc_confirmed_at"] = message.get("awc_confirmed_at")
    return latest


def handshake_url(
    base: str,
    airports: list[str],
    *,
    snapshot: bool = True,
    since_seq: int | None = None,
    boot_id: str | None = None,
) -> str:
    parsed = urllib.parse.urlsplit(base)
    params = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
    params["airports"] = ",".join(airports)
    if snapshot:
        params["snapshot"] = "true"
    if since_seq is not None and boot_id:
        params["since_seq"] = str(since_seq)
        params["boot_id"] = boot_id
    query = urllib.parse.urlencode(params)
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path or "/v1/ws/metar", query, ""))


def latest_url(base: str, airports: list[str]) -> str:
    parsed = urllib.parse.urlsplit(base)
    scheme = "https" if parsed.scheme in {"wss", "https"} else "http"
    netloc = parsed.netloc
    path = "/v1/metar/latest"
    query = urllib.parse.urlencode({"airports": ",".join(airports)})
    return urllib.parse.urlunsplit((scheme, netloc, path, query, ""))


def fetch_latest(url: str, token: str, airports: list[str]) -> list[dict]:
    target = latest_url(url, airports)
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    request = urllib.request.Request(target, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            body = json.loads(response.read().decode())
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return []
    return list(body.get("data") or [])



def _outage_key(message: dict) -> str:
    return str(message.get("outage_id") or message.get("icao") or "")


class MetarClient:
    """Reconnecting client for /v1/ws/metar."""

    fetch_latest = staticmethod(fetch_latest)

    def __init__(
        self,
        airports: list[str],
        *,
        token: str | None = None,
        url: str = DEFAULT_URL,
        snapshot: bool = True,
        resume: bool = True,
        state: str | None = None,
        bbox: dict | None = None,
        platform: str | None = None,
        on_record: Callable[[dict], Any] | None = None,
        on_frame: Callable[[dict], Any] | None = None,
    ) -> None:
        self.url = url
        self.token = resolve_token(token)
        self.airports = [name.upper() for name in airports]
        self.snapshot = snapshot
        self.resume = resume
        self.on_record = on_record
        self.on_frame = on_frame
        self.latest: dict[str, dict] = {}
        self.boot_id: str | None = None
        self.seq: int | None = None
        self._delay = BACKOFF_START_S
        self._stop = asyncio.Event()
        self._ws: Any = None
        self.last_usage: dict | None = None
        self.last_late: dict | None = None
        self.last_recovered: dict | None = None
        self.lates: dict[str, dict] = {}  # latest station_late per outage_id
        self.last_error: dict | None = None
        self.held_icaos: list[str] = list(self.airports)
        self.states: list[str] = []
        self.bboxes: list[dict] = []
        self.platforms: list[str] = []
        self._session_open = False
        self._grant_resume_pending = False
        if state:
            self.states.append(str(state).upper())
        if bbox:
            self.bboxes.append(dict(bbox))
        if platform:
            self.platforms.append(str(platform).lower())

    def handshake_url(self) -> str:
        # Grants are mid-session only. If any are held, omit since_seq and
        # boot_id here so the post-connect resubscribe can be the one resume.
        use_resume = self.resume and not self.has_grants()
        return handshake_url(
            self.url,
            self.airports,
            snapshot=self.snapshot if not self.has_grants() else False,
            since_seq=self.seq if use_resume else None,
            boot_id=self.boot_id if use_resume else None,
        )

    def has_grants(self) -> bool:
        return bool(self.states or self.bboxes or self.platforms)

    def handle_frame(self, message: dict) -> None:
        kind = message.get("type")
        if kind == "subscription_updated":
            if message.get("boot_id"):
                self.boot_id = message["boot_id"]
            if "icaos" in message and isinstance(message.get("icaos"), list):
                self.held_icaos = [str(item).upper() for item in message["icaos"]]
            if self._session_open:
                self._remember_grants_from(message)
            elif self.has_grants():
                self._grant_resume_pending = True
            self._session_open = True
            # Do not take seq from subscription_updated: it is the server's
            # current seq, and would skip replay frames not yet received.
        elif kind == "error":
            self.last_error = message
        elif kind == "resume":
            self._apply_resume(self.fetch_latest(self.url, self.token, self.held_icaos or self.airports))
        elif kind == "new_metar_arrived":
            live = message.get("cached") is False and message.get("replay") is False
            replayed = message.get("replay") is True
            for rec in message.get("data") or []:
                before = self.latest.get(rec.get("icao") or "")
                merge_record(self.latest, rec, live=live)
                self._emit(rec.get("icao"), before)
            if (live or replayed) and message.get("seq") is not None:
                self._advance_seq(message["seq"])
        elif kind == "awc_confirmed":
            if message.get("seq") is not None:
                self._advance_seq(message["seq"])
            icao = message.get("icao")
            before = dict(self.latest[icao]) if icao and icao in self.latest else None
            apply_awc_confirmed(self.latest, message)
            self._emit(icao, before)
        elif kind in {"station_late", "station_recovered", "usage"}:
            if message.get("seq") is not None:
                self._advance_seq(message["seq"])
            if kind == "usage":
                self.last_usage = message
            elif kind == "station_late":
                self.last_late = message
                self.lates[_outage_key(message)] = message
            else:
                self.last_recovered = message
                key = _outage_key(message)
                self.lates.pop(key, None)
                held = self.last_late
                if held is not None and _outage_key(held) == key:
                    self.last_late = None
        # Unknown types (pong, server_notice, error, and any later type) are ignored.
        if self.on_frame is not None:
            self.on_frame(message)

    def _advance_seq(self, seq: int) -> None:
        if self.seq is None or seq > self.seq:
            self.seq = seq

    def _apply_resume(self, rows: list[dict]) -> None:
        for rec in rows:
            before = self.latest.get(rec.get("icao") or "")
            merge_record(self.latest, rec, live=False)
            self._emit(rec.get("icao"), before)

    async def _handle_message(self, message: dict) -> None:
        if message.get("type") == "resume":
            rows = await asyncio.to_thread(self.fetch_latest, self.url, self.token, self.held_icaos or self.airports)
            self._apply_resume(rows)
            if self.on_frame is not None:
                self.on_frame(message)
            return
        self.handle_frame(message)

    def _emit(self, icao: str | None, before: dict | None) -> None:
        if not icao or self.on_record is None:
            return
        held = self.latest.get(icao)
        if held is not None and held is not before and held != before:
            self.on_record(held)

    async def request_usage(self) -> None:
        """Send {"action":"usage"} on the open socket, if any."""
        ws = self._ws
        if ws is not None:
            await ws.send(json.dumps({"action": "usage"}))

    def subscribe_body(
        self,
        icaos: list[str] | None = None,
        *,
        state: str | None = None,
        bbox: dict | None = None,
        platform: str | None = None,
        since_seq: int | None = None,
        boot_id: str | None = None,
        snapshot: bool | None = None,
        **fields: Any,
    ) -> dict[str, Any]:
        """Return the mid-session subscribe JSON object (exact wire format)."""
        body: dict[str, Any] = {"action": "subscribe"}
        if icaos is not None:
            body["icaos"] = [str(item).upper() for item in icaos]
        if state is not None:
            body["state"] = str(state).upper()
        if bbox is not None:
            body["bbox"] = dict(bbox)
        if platform is not None:
            body["platform"] = str(platform).lower()
        if since_seq is not None and boot_id:
            body["since_seq"] = since_seq
            body["boot_id"] = boot_id
        if snapshot is not None:
            body["snapshot"] = bool(snapshot)
        body.update(fields)
        return body

    def reconnect_subscribe_bodies(self) -> list[dict[str, Any]]:
        """Messages that restore explicit airports and grants after a reconnect.

        The first message may include one ``state``, one ``bbox``, and one
        ``platform`` plus ``icaos``, ``since_seq``, and ``boot_id`` so grant
        stations can be replayed. Further grants of the same kind, if any,
        are sent afterwards with ``snapshot: true`` and without resume
        (resume is once per socket), so those stations are restored by
        snapshot, not replay.
        """
        states = list(self.states)
        bboxes = list(self.bboxes)
        platforms = list(self.platforms)
        first = self.subscribe_body(
            icaos=list(self.airports) or None,
            state=states.pop(0) if states else None,
            bbox=bboxes.pop(0) if bboxes else None,
            platform=platforms.pop(0) if platforms else None,
            since_seq=self.seq if self.resume else None,
            boot_id=self.boot_id if self.resume else None,
            snapshot=True if self.snapshot else None,
        )
        bodies = [first]
        while states or bboxes or platforms:
            bodies.append(
                self.subscribe_body(
                    state=states.pop(0) if states else None,
                    bbox=bboxes.pop(0) if bboxes else None,
                    platform=platforms.pop(0) if platforms else None,
                    snapshot=True,
                )
            )
        return bodies

    def _remember_grants_from(self, message: dict) -> None:
        regions = message.get("regions") or []
        platforms = message.get("platforms") or []
        states: list[str] = []
        bboxes: list[dict] = []
        for item in regions:
            raw = str(item)
            if raw.lower().startswith("state:"):
                states.append(raw.split(":", 1)[1].upper())
            elif raw.lower().startswith("bbox:"):
                parts = raw.split(":", 1)[1].split(",")
                if len(parts) == 4:
                    try:
                        south, west, north, east = (float(part) for part in parts)
                    except ValueError:
                        continue
                    bboxes.append({"south": south, "west": west, "north": north, "east": east})
        self.states = states
        self.bboxes = bboxes
        self.platforms = [str(name).lower() for name in platforms]

    def _remember_outgoing_grants(self, body: dict) -> None:
        if body.get("state"):
            code = str(body["state"]).upper()
            if code not in self.states:
                self.states.append(code)
        if body.get("bbox") is not None:
            self.bboxes.append(dict(body["bbox"]))
        if body.get("platform"):
            name = str(body["platform"]).lower()
            if name not in self.platforms:
                self.platforms.append(name)
        if body.get("icaos"):
            held = set(self.airports)
            for item in body["icaos"]:
                code = str(item).upper()
                if code not in held:
                    self.airports.append(code)
                    held.add(code)

    async def subscribe(self, icaos: list[str] | None = None, **fields: Any) -> None:
        """Send a mid-session subscribe. Pass filter=, delta=, state=, bbox=, or platform=."""
        ws = self._ws
        if ws is None:
            return
        body = self.subscribe_body(icaos if icaos is not None else [], **fields)
        self._remember_outgoing_grants(body)
        await ws.send(json.dumps(body))

    async def unsubscribe(self, icaos: list[str] | None = None, **fields: Any) -> None:
        """Send a mid-session unsubscribe for icaos and/or a grant."""
        ws = self._ws
        if ws is None:
            return
        body: dict[str, Any] = {"action": "unsubscribe"}
        if icaos is not None:
            body["icaos"] = [str(item).upper() for item in icaos]
        if "state" in fields and fields["state"] is not None:
            body["state"] = str(fields["state"]).upper()
        if "bbox" in fields and fields["bbox"] is not None:
            body["bbox"] = dict(fields["bbox"])
        if "platform" in fields and fields["platform"] is not None:
            body["platform"] = str(fields["platform"]).lower()
        for key, value in fields.items():
            if key not in {"state", "bbox", "platform"}:
                body[key] = value
        await ws.send(json.dumps(body))

    async def _flush_grant_resume(self) -> None:
        ws = self._ws
        if not self._grant_resume_pending or ws is None:
            return
        self._grant_resume_pending = False
        for body in self.reconnect_subscribe_bodies():
            await ws.send(json.dumps(body))

    def stop(self) -> None:
        self._stop.set()
        ws = self._ws
        if ws is not None:
            try:
                asyncio.get_running_loop().create_task(ws.close())
            except RuntimeError:
                pass

    async def _session(self) -> str | int | None:
        headers = {"Authorization": f"Bearer {self.token}"}
        opened: float | None = None
        saw_message = False
        ping_task: asyncio.Task | None = None
        try:
            async with connect(self.handshake_url(), additional_headers=headers) as ws:
                opened = time.monotonic()
                self._ws = ws

                async def heartbeat() -> None:
                    while True:
                        await asyncio.sleep(PING_EVERY_S)
                        if self._stop.is_set():
                            return
                        await ws.send(json.dumps({"action": "ping"}))
                        try:
                            await asyncio.wait_for(pong.wait(), timeout=PONG_TIMEOUT_S)
                        except asyncio.TimeoutError:
                            await ws.close(code=1001, reason="pong timeout")
                            return
                        finally:
                            pong.clear()

                pong = asyncio.Event()
                ping_task = asyncio.create_task(heartbeat())
                self._session_open = False
                self._grant_resume_pending = False
                async for text in ws:
                    if self._stop.is_set():
                        break
                    if not saw_message:
                        saw_message = True
                        self._delay = BACKOFF_START_S
                    message = json.loads(text)
                    if message.get("type") == "pong":
                        pong.set()
                    await self._handle_message(message)
                    await self._flush_grant_resume()
        except ConnectionClosed as exc:
            if saw_message or (opened is not None and time.monotonic() - opened >= QUIET_OPEN_S):
                self._delay = BACKOFF_START_S
            return exc.rcvd.code if exc.rcvd is not None else exc.sent.code if exc.sent is not None else 1006
        except (InvalidStatus, OSError, TimeoutError, asyncio.TimeoutError) as exc:
            return connect_failure_code(exc)
        finally:
            self._ws = None
            if ping_task is not None:
                ping_task.cancel()
        if opened is not None and (saw_message or time.monotonic() - opened >= QUIET_OPEN_S):
            self._delay = BACKOFF_START_S
        return None

    async def run_forever(self) -> None:
        self._stop = asyncio.Event()
        while not self._stop.is_set():
            code = await self._session()
            if self._stop.is_set():
                return
            if not should_retry(code if isinstance(code, int) else None):
                return
            wait = self._delay * (0.5 + random.random())
            self._delay = min(self._delay * 2.0, BACKOFF_CAP_S)
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=wait)
                return
            except asyncio.TimeoutError:
                pass


class MetarExample(MetarClient):
    """Backward-compatible constructor: (url, token, airports)."""

    def __init__(self, url: str, token: str, airports: list[str], **kwargs) -> None:
        super().__init__(airports, token=token, url=url, **kwargs)
