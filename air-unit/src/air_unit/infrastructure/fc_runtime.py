"""Flight-controller runtime — the single owner of the MAVLink link.

Ported in spirit from Air-Unit's `PymavlinkFC` / `FcRuntime`, but built for the
multi-drone SITL case: ONE UDP socket carries every drone. We own the socket
directly (rather than letting pymavlink hide it) so every datagram's *source
address* is captured on receive and mapped to its system id — then commands are
sent to that exact address. That is what gives unambiguous per-drone targeting
when four SITL drones share one port (pymavlink alone would send every command
to whichever drone transmitted last).

Responsibilities:
  * background receive loop -> DroneRegistry (telemetry + STATUSTEXT)
  * per-sysid source-address tracking
  * targeted command senders (arm / takeoff / mode / reposition / set-current)
  * MAVLink mission-upload state machine (per drone)
  * lightweight preflight check from the latest snapshot
"""
from __future__ import annotations

import asyncio
import logging
import math
import socket
import threading
import time
from dataclasses import dataclass
from typing import Awaitable, Callable, Dict, List, Optional

from pymavlink import mavutil

from ..core.enums import mode_number
from ..mavlink.aggregator import DroneRegistry
from ..models import MissionProgress, PreflightCheck, PreflightResult

log = logging.getLogger("airunit.fc")

mav = mavutil.mavlink  # constant + message-class namespace (ardupilotmega dialect)

ProgressCb = Callable[[MissionProgress], Awaitable[None]]

# How long a REAL (serial) drone keeps ownership of a system id after its last
# packet — long enough to ride out telemetry-radio dropouts so a same-sysid SITL
# drone can't flicker back in.
REAL_GRACE_SEC = 10.0

# A telemetry radio that is unplugged, or not plugged in yet, is retried this
# often — so radios can be connected in any order, before or after the backend.
SERIAL_RETRY_SEC = 2.0
# `serial:auto` rescans the USB serial ports this often for newly plugged radios.
SERIAL_SCAN_SEC = 3.0
# One system id heard on two radios within this window = two aircraft sharing a
# SYSID_THISMAV. Their telemetry would merge and commands would reach whichever
# spoke last, so the id is locked until the clash is fixed.
CONFLICT_WINDOW_SEC = 5.0
# SiK radios inject RADIO_STATUS under their own ids (sysid 51, this component).
# Not an aircraft — and every radio uses the same id, so it would read as a clash.
COMP_TELEMETRY_RADIO = 68

# Mission upload over a lossy telemetry radio.
# No request for item 0 this long after MISSION_COUNT -> the count was lost; resend.
MISSION_COUNT_RETRY_SEC = 1.5
MISSION_COUNT_RETRIES = 3
# Silence this long mid-upload = link is gone (ArduPilot itself gives up at 8 s).
MISSION_ITEM_TIMEOUT_SEC = 5.0
# A re-request for the item we just sent: within this window it is a duplicated
# copy of the same request (SITL double-forwarding) and must be ignored; later
# than this it is ArduPilot's ~1 s retry because our item was lost — resend it.
MISSION_RESEND_MIN_SEC = 0.5

# Turn-then-fly at mission corners. Left alone, ArduCopter (WP_YAW_BEHAVIOR=2)
# swings the nose round while it is already flying the next leg, so the camera
# sweeps sideways across the ground. Instead the upload stops the aircraft at a
# corner, turns it on the spot to face the next waypoint, then lets it fly.
# Heading changes smaller than this are flown through without stopping.
TURN_MIN_DEG = 10.0
# Yaw rate asked for in the turn (deg/s); the FC's ATC limits still apply.
TURN_RATE_DPS = 45.0
# Extra hover after the turn should be done, for the nose to settle.
TURN_SETTLE_SEC = 1.0
# Waypoints closer than this give no meaningful bearing, so no turn is planned.
TURN_MIN_LEG_M = 1.0
# Live turns (Reposition / Jump): within this many degrees counts as facing.
TURN_DONE_DEG = 5.0
# Ground speed (m/s) below which the aircraft counts as stopped for a turn.
STOPPED_MS = 0.5
# Longest wait for the aircraft to brake before turning anyway.
BRAKE_TIMEOUT_SEC = 8.0


def _bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Initial great-circle bearing from point 1 to point 2, 0-360 (0 = north)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360.0) % 360.0


def _dist_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Ground distance (m); equirectangular, fine at waypoint spacing."""
    x = math.radians(lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    y = math.radians(lat2 - lat1)
    return 6371000.0 * math.hypot(x, y)


def _turn_deg(a: float, b: float) -> float:
    """Size of the smallest turn between two headings, 0-180."""
    return abs((b - a + 180.0) % 360.0 - 180.0)


def _yaw_item(heading: float) -> dict:
    """CONDITION_YAW to an absolute heading, the shorter way round.
    p1 = heading deg, p2 = rate deg/s, p3 = 0 shortest, p4 = 0 absolute."""
    return {
        "lat": 0.0, "lon": 0.0, "alt": 0.0,
        "command": mavutil.mavlink.MAV_CMD_CONDITION_YAW,
        "p1": round(heading, 1), "p2": TURN_RATE_DPS, "p3": 0.0, "p4": 0.0,
    }


def _param_name(msg) -> str:
    """PARAM_VALUE.param_id arrives as a 16-byte NUL-padded field (bytes on some
    pymavlink builds, str on others). Normalise to a bare upper-case name."""
    pid = getattr(msg, "param_id", "")
    if isinstance(pid, (bytes, bytearray)):
        pid = pid.decode("ascii", errors="ignore")
    return pid.replace("\x00", "").strip().upper()


def _result_name(result: int) -> str:
    enum = mavutil.mavlink.enums.get("MAV_RESULT", {})
    if result in enum:
        return enum[result].name.replace("MAV_RESULT_", "")
    return f"result {result}"


@dataclass(frozen=True)
class Ack:
    """The flight controller's COMMAND_ACK verdict for one command."""

    received: bool  # False when nothing came back before the timeout
    result: int     # MAV_RESULT, or -1 when nothing came back
    name: str       # short MAV_RESULT name, or "timeout"

    @property
    def ok(self) -> bool:
        return self.result == mav.MAV_RESULT_ACCEPTED

    @property
    def unsupported(self) -> bool:
        """The FC does not implement this command (old firmware, no hardware)."""
        return self.result == mav.MAV_RESULT_UNSUPPORTED


class FcRuntime:
    def __init__(self, connection: str, registry: DroneRegistry) -> None:
        self._endpoints = self._parse(connection)
        self.registry = registry

        self._rx_socks: list[socket.socket] = []
        self._serials: Dict[str, object] = {}  # port name -> open pyserial port
        self._managed_ports: set[str] = set()  # ports with a supervisor thread
        self._link_lock = threading.Lock()     # guards the two above + _heard_on
        # sysid -> {serial port name: last heard}. Feeds conflict().
        self._heard_on: Dict[int, Dict[str, float]] = {}
        # sysid -> the listening socket a UDP drone is heard on. Replies MUST
        # leave from that socket (i.e. from port 14550): SITL's udpclient is a
        # connected socket and silently drops datagrams from any other port, so
        # a separate send socket meant no command or stream request ever landed.
        self._udp_sock: Dict[int, socket.socket] = {}
        # TX codec — encoding runs on the single asyncio thread, guarded by lock.
        self._tx_mav = mav.MAVLink(None, srcSystem=255, srcComponent=190)

        self._send_lock = threading.Lock()
        # sysid -> route for sending: ("udp", (ip,port)) or ("serial", serial_obj)
        self._route: Dict[int, tuple] = {}
        self._connected: set[int] = set()
        self._seen: set[int] = set()
        self._real_seen: Dict[int, float] = {}  # sysid -> last serial-msg time
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._mission_q: Dict[int, asyncio.Queue] = {}
        # (sysid, command) -> LIST of queues fed with that command's COMMAND_ACKs,
        # so a sender can await the FC's verdict instead of sleeping and hoping.
        # A list, not a single queue: concurrent callers on the same key must not
        # clobber each other (see _fanout / _waiter).
        self._ack_q: Dict[tuple, list] = {}
        # (sysid, PARAM_NAME) -> LIST of queues fed with that parameter's PARAM_VALUEs.
        self._param_q: Dict[tuple, list] = {}
        # Bumped by any emergency command; long sequences watch it and bail out.
        self._abort_gen: Dict[int, int] = {}
        # sysid -> mission seq of each waypoint the operator drew, in order.
        # The operator counts waypoints 1..N; the aircraft counts mission items,
        # where 0 is home and takeoff/DO_CHANGE_SPEED sit in between. Recorded at
        # upload so a "jump to waypoint 3" means waypoint 3 and not item 3.
        self._wp_seq: Dict[int, List[int]] = {}
        # sysid -> (lat, lon) of each of those waypoints, same order, so a jump
        # knows which way to face before it flies there.
        self._wp_pts: Dict[int, List[tuple]] = {}
        # sysid -> the cruise speed (m/s) the operator last uploaded or applied.
        self._cruise_ms: Dict[int, float] = {}
        # Bumped by each new reposition / jump, so a turn still in progress
        # gives way to the operator's newer click instead of finishing it.
        self._maneuver_gen: Dict[int, int] = {}

    @staticmethod
    def _parse(connection: str) -> list[dict]:
        # Comma-separated endpoints:
        #   udpin:host:port / udp:host:port / host:port / :port   -> UDP (SITL)
        #   udpin:host:14550-14559                                -> a UDP port range
        #   serial:PORT:BAUD  (e.g. serial:COM3:57600)            -> telemetry radio
        #   serial:auto:BAUD                                      -> every USB serial port
        # There is no drone limit: any number of drones can share one UDP port
        # (they are told apart by system id). A range is only for SITL setups
        # that give each instance its own port.
        eps: list[dict] = []

        def udp(host: str, port: str) -> None:
            lo, sep, hi = port.partition("-")
            first = int(lo)
            last = int(hi) if sep else first
            if last < first:
                raise ValueError(f"bad port range '{port}'")
            for p in range(first, last + 1):
                eps.append({"kind": "udp", "host": host, "port": p})

        for part in connection.split(","):
            part = part.strip()
            if not part:
                continue
            if part.lower().startswith("serial:"):
                rest = part[len("serial:"):]
                port, _, baud = rest.rpartition(":")
                if not port:  # no baud given -> the whole rest is the port
                    port, baud = rest, "57600"
                kind = "serial_auto" if port.lower() == "auto" else "serial"
                eps.append({"kind": kind, "port": port, "baud": int(baud or 57600)})
                continue
            toks = part.split(":")
            if len(toks) == 3:
                udp(toks[1], toks[2])
            elif len(toks) == 2 and not toks[0].startswith("udp"):
                udp(toks[0] or "0.0.0.0", toks[1])
            elif len(toks) == 2:
                udp("0.0.0.0", toks[1])
            else:
                raise ValueError(f"cannot parse endpoint '{part}'")
        if not eps:
            raise ValueError(f"no endpoints in '{connection}'")
        return eps

    # --- lifecycle ----------------------------------------------------------
    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def start(self) -> None:
        for ep in self._endpoints:
            if ep["kind"] == "udp":
                s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                try:
                    s.bind((ep["host"], ep["port"]))
                except OSError as e:
                    # One busy port (another GCS, a stale run) must not take
                    # down every other drone — skip it, like a missing radio.
                    log.error("could not listen on %s:%d: %s", ep["host"], ep["port"], e)
                    s.close()
                    continue
                s.settimeout(1.0)
                self._rx_socks.append(s)
                self._spawn(self._recv_loop, s, name=f"fc-recv-{ep['port']}")
                log.info("fc runtime listening on %s:%d", ep["host"], ep["port"])
            elif not self._have_pyserial():
                continue
            elif ep["kind"] == "serial":  # one named telemetry radio
                self._manage_serial(ep["port"], ep["baud"], auto=False)
            else:  # serial:auto — every USB serial port, hot-plugged
                self._spawn(self._scan_serial, ep["baud"], name="fc-serial-scan")

    def _spawn(self, target, *args, name: str) -> None:
        t = threading.Thread(target=target, args=args, name=name, daemon=True)
        t.start()
        self._threads.append(t)

    @staticmethod
    def _have_pyserial() -> bool:
        try:
            import serial  # noqa: F401
        except ImportError:
            log.error("pyserial not installed — run: pip install pyserial")
            return False
        return True

    def _manage_serial(self, port: str, baud: int, auto: bool) -> None:
        """Give a port its supervisor thread, unless it already has one."""
        with self._link_lock:
            if port in self._managed_ports:
                return
            self._managed_ports.add(port)
        self._spawn(self._serial_supervisor, port, baud, auto, name=f"fc-serial-{port}")

    def _scan_serial(self, baud: int) -> None:
        """serial:auto — pick up every USB serial adapter, including ones
        plugged in later. Radios change COM number with the USB socket they are
        plugged into, so naming them in config is fragile with several."""
        from serial.tools import list_ports

        log.info("auto-detecting telemetry radios on USB serial ports @ %d", baud)
        while not self._stop.is_set():
            try:
                ports = list_ports.comports()
            except Exception:
                ports = []
            for p in ports:
                # USB adapters only (SiK radios are FTDI / CP210x). Skips the
                # motherboard COM1 and Bluetooth virtual ports, which have no VID.
                if p.vid is not None:
                    self._manage_serial(p.device, baud, auto=True)
            self._stop.wait(SERIAL_SCAN_SEC)

    def _serial_supervisor(self, port: str, baud: int, auto: bool) -> None:
        """Keep one telemetry radio open: open it, read until it fails, reopen.

        A radio that is not plugged in yet, or is pulled mid-flight, used to be
        skipped (or read dead) until the backend restarted. Now it is retried,
        so radios can be plugged in any order at any time. For `auto` ports the
        thread exits instead of retrying and the scanner re-offers the port if
        it reappears — a port that is simply gone should not be polled forever.
        """
        import serial

        waiting_logged = False
        try:
            while not self._stop.is_set():
                try:
                    ser = serial.Serial(port, baud, timeout=1.0)
                except Exception as e:
                    if auto:
                        log.debug("skipping %s: %s", port, e)  # busy or gone
                        return
                    if not waiting_logged:
                        log.warning(
                            "telemetry radio %s not available (%s) — retrying every %gs",
                            port, e, SERIAL_RETRY_SEC,
                        )
                        waiting_logged = True
                    self._stop.wait(SERIAL_RETRY_SEC)
                    continue
                waiting_logged = False
                log.info("telemetry radio open: %s @ %d", port, baud)
                with self._link_lock:
                    self._serials[port] = ser
                try:
                    self._recv_loop_serial(ser)
                finally:
                    with self._link_lock:
                        self._serials.pop(port, None)
                    self._drop_routes_via(ser)
                    try:
                        ser.close()
                    except Exception:
                        pass
                if self._stop.is_set():
                    return
                log.warning("telemetry radio lost: %s%s", port, "" if auto else " — reopening")
                if auto:
                    return
                self._stop.wait(SERIAL_RETRY_SEC)
        finally:
            with self._link_lock:
                self._managed_ports.discard(port)

    def _drop_routes_via(self, ser) -> None:
        """A radio died: stop sending through it. The drones behind it keep
        their roster rows until evict_sec, and get a route back on their next
        packet if the radio returns."""
        for sid, r in list(self._route.items()):
            if r[0] == "serial" and r[1] is ser:
                self._route.pop(sid, None)

    def stop(self) -> None:
        self._stop.set()
        for s in self._rx_socks:
            try:
                s.close()
            except Exception:
                pass
        with self._link_lock:
            serials = list(self._serials.values())
        for ser in serials:
            try:
                ser.close()
            except Exception:
                pass

    # --- receive ------------------------------------------------------------
    def _recv_loop(self, sock: socket.socket) -> None:
        # Each socket/thread gets its own parser (MAVLink parsers are stateful).
        rx = mav.MAVLink(None)
        rx.robust_parsing = True
        while not self._stop.is_set():
            try:
                data, addr = sock.recvfrom(65535)
            except socket.timeout:
                continue
            except ConnectionResetError:
                # Windows: a prior send drew an ICMP port-unreachable; spurious
                # for a listening socket — keep going.
                continue
            except OSError:
                break
            try:
                msgs = rx.parse_buffer(data) or []
            except Exception:
                msgs = []
            self._handle(msgs, ("udp", addr), sock)

    def _recv_loop_serial(self, ser) -> None:
        """Read MAVLink from a telemetry radio (real drone) and route it like a
        UDP link, keyed by the drone's own system id. Returns when the port
        fails (unplugged) so the supervisor can reopen it — retrying reads on a
        dead handle never recovers."""
        rx = mav.MAVLink(None)
        rx.robust_parsing = True
        while not self._stop.is_set():
            try:
                n = ser.in_waiting or 1
                data = ser.read(n)
            except Exception as e:
                log.debug("serial read failed on %s: %s", getattr(ser, "port", "?"), e)
                return
            if not data:
                continue
            try:
                msgs = rx.parse_buffer(data) or []
            except Exception:
                msgs = []
            self._handle(msgs, ("serial", ser))

    def _handle(self, msgs, route: tuple, sock: Optional[socket.socket] = None) -> None:
        kind = route[0]
        for msg in msgs:
            try:
                if msg.get_srcComponent() == COMP_TELEMETRY_RADIO:
                    continue  # the radio's own RADIO_STATUS, not an aircraft
                sysid = msg.get_srcSystem()
                if sysid and sysid not in (0, 255):
                    # REAL (serial) drones take priority over SIM (udp) on the same
                    # system id: while a real drone has been heard within the grace
                    # window, drop ALL SITL frames for that sysid so the real one
                    # keeps the slot even through telemetry-radio dropouts.
                    if kind == "serial":
                        now = time.time()
                        self._real_seen[sysid] = now
                        self._note_heard(sysid, route[1].port, now)
                    elif kind == "udp":
                        rs = self._real_seen.get(sysid)
                        if rs is not None and (time.time() - rs) < REAL_GRACE_SEC:
                            continue
                    if sysid not in self._seen or self._route.get(sysid, (None,))[0] != kind:
                        self._seen.add(sysid)
                        where = route[1] if kind == "udp" else getattr(route[1], "port", "serial")
                        log.info("drone sysid %d via %s %s", sysid, kind, where)
                    self._route[sysid] = route
                    if sock is not None:
                        self._udp_sock[sysid] = sock
                self.registry.ingest(msg)
                self._route_protocol(msg, sysid)
            except Exception:
                log.exception("message handling error")

    def _note_heard(self, sysid: int, port: str, now: float) -> None:
        with self._link_lock:
            heard = self._heard_on.setdefault(sysid, {})
            fresh = port not in heard or now - heard[port] >= CONFLICT_WINDOW_SEC
            heard[port] = now
            others = [p for p, t in heard.items()
                      if p != port and now - t < CONFLICT_WINDOW_SEC]
        if fresh and others:
            log.error(
                "SYSID CONFLICT: sysid %d heard on %s and %s — two aircraft share "
                "SYSID_THISMAV. Commands to it are blocked until one is changed.",
                sysid, port, ", ".join(others),
            )

    def conflict(self, sysid: int) -> List[str]:
        """Serial ports carrying this sysid right now, when there is more than
        one; [] when the sysid is unambiguous.

        One radio pair per drone means one port per sysid. Two ports means two
        aircraft with the same SYSID_THISMAV (the ArduPilot default is 1 on
        every board), or one aircraft plugged in twice (radio + USB). Either way
        we cannot tell which aircraft a command would reach.
        """
        now = time.time()
        with self._link_lock:
            heard = self._heard_on.get(sysid, {})
            ports = sorted(p for p, t in heard.items() if now - t < CONFLICT_WINDOW_SEC)
        return ports if len(ports) > 1 else []

    def link_names(self) -> Dict[int, str]:
        """sysid -> where it is heard: "COM4", or "ip:port" for UDP. Lets the
        operator match a roster row to a physical radio."""
        out: Dict[int, str] = {}
        for s, (kind, target) in list(self._route.items()):
            if kind == "serial":
                out[s] = str(getattr(target, "port", "serial"))
            else:
                out[s] = f"{target[0]}:{target[1]}"
        return out

    def _route_protocol(self, msg, sysid: int) -> None:
        """Hand protocol replies to whichever coroutine is waiting on them."""
        mtype = msg.get_type()
        if mtype in ("MISSION_REQUEST_INT", "MISSION_REQUEST", "MISSION_ACK"):
            q = self._mission_q.get(sysid)
            if q is not None and self._loop is not None:
                self._loop.call_soon_threadsafe(q.put_nowait, msg)
        elif mtype == "COMMAND_ACK":
            self._fanout(self._ack_q, (sysid, int(msg.command)), msg)
        elif mtype == "PARAM_VALUE":
            self._fanout(self._param_q, (sysid, _param_name(msg)), msg)

    def _fanout(self, table: Dict[tuple, list], key: tuple, msg) -> None:
        """Deliver to EVERY waiter on this key, not just the newest.

        A single dict slot let a second caller clobber the first's queue, so the
        first waited out its whole timeout on a command the FC had answered. For
        PARAM_VALUE fan-out is plainly right — the value is the same for every
        reader; for COMMAND_ACK it is the honest option, since two identical
        commands are indistinguishable on the wire anyway.
        """
        waiters = table.get(key)
        if not waiters or self._loop is None:
            return
        for q in list(waiters):
            self._loop.call_soon_threadsafe(q.put_nowait, msg)

    @staticmethod
    def _waiter(table: Dict[tuple, list], key: tuple) -> asyncio.Queue:
        """Register a queue for `key` alongside any existing ones."""
        q: asyncio.Queue = asyncio.Queue()
        table.setdefault(key, []).append(q)
        return q

    @staticmethod
    def _unwaiter(table: Dict[tuple, list], key: tuple, q: asyncio.Queue) -> None:
        """Remove only OUR queue — never another caller's."""
        waiters = table.get(key)
        if not waiters:
            return
        try:
            waiters.remove(q)
        except ValueError:
            pass
        if not waiters:
            table.pop(key, None)

    # --- send helpers -------------------------------------------------------
    def _send_to(self, sysid: int, data: bytes, fanout: bool = False) -> None:
        """Send to the one aircraft behind `sysid`.

        On a SYSID conflict there is no "one aircraft", so everything is refused
        here — at the bottom, so no sequence can slip past a check made higher
        up. The exception is `fanout` (disarm / kill): that goes to EVERY radio
        carrying the sysid. Stopping both is the safe answer when you cannot
        tell them apart — typically one is flying and the other was just
        powered on the bench.
        """
        clash = self.conflict(sysid)
        if clash:
            if not fanout:
                raise RuntimeError(
                    f"SYSID {sysid} is used by more than one aircraft "
                    f"({', '.join(clash)}) — refusing to guess which one to command"
                )
            with self._link_lock:
                targets = [self._serials[p] for p in clash if p in self._serials]
            for ser in targets:
                ser.write(data)
            return
        route = self._route.get(sysid)
        if not route:
            raise RuntimeError(f"no route for sysid {sysid} (not seen yet)")
        kind, target = route
        if kind == "udp":
            self._udp_sock[sysid].sendto(data, target)
        else:  # serial telemetry radio
            target.write(data)

    def _cmd_long(self, sysid: int, command: int, *params: float, fanout: bool = False) -> None:
        p = list(params) + [0.0] * (7 - len(params))
        with self._send_lock:
            m = self._tx_mav.command_long_encode(sysid, 1, command, 0, *p[:7])
            data = m.pack(self._tx_mav)
        self._send_to(sysid, data, fanout=fanout)

    def _cmd_int(
        self, sysid: int, frame: int, command: int,
        p1: float, p2: float, p3: float, p4: float,
        x: int, y: int, z: float,
    ) -> None:
        with self._send_lock:
            m = self._tx_mav.command_int_encode(
                sysid, 1, frame, command, 0, 0, p1, p2, p3, p4, x, y, z
            )
            data = m.pack(self._tx_mav)
        self._send_to(sysid, data)

    def _send_encoded(self, sysid: int, msg) -> None:
        with self._send_lock:
            data = msg.pack(self._tx_mav)
        self._send_to(sysid, data)

    # --- connection lifecycle (per drone) -----------------------------------
    def is_known(self, sysid: int) -> bool:
        return sysid in self._route

    def is_connected(self, sysid: int) -> bool:
        """True once the operator has pressed Connect for this drone. Being
        heard on the wire (is_known) is NOT enough to be streamed or commanded."""
        return sysid in self._connected

    def connected_sysids(self) -> set[int]:
        return set(self._connected)

    def route_kinds(self) -> Dict[int, str]:
        """sysid -> "serial" (real drone via telemetry) or "udp" (SITL)."""
        return {s: r[0] for s, r in self._route.items()}

    def connect(self, sysid: int, rate_hz: int = 5) -> bool:
        """Request data streams from a drone and mark it connected."""
        if sysid not in self._route:
            return False
        with self._send_lock:
            m = self._tx_mav.request_data_stream_encode(
                sysid, 1, mav.MAV_DATA_STREAM_ALL, rate_hz, 1
            )
            data = m.pack(self._tx_mav)
        self._send_to(sysid, data)
        self._connected.add(sysid)
        # ArduPilot only emits HOME_POSITION on request (and when home moves), so
        # ask once here — the geofence circle and RTL target both depend on it.
        try:
            self._cmd_long(sysid, mav.MAV_CMD_GET_HOME_POSITION)
        except Exception:
            log.debug("sysid %d: home request failed", sysid)
        log.info("connected sysid %d (streams @ %d Hz)", sysid, rate_hz)
        return True

    def disconnect(self, sysid: int) -> None:
        self._connected.discard(sysid)

    def forget(self, sysid: int) -> None:
        """Drop all trace of a drone that has gone away (pruned)."""
        self._connected.discard(sysid)
        self._route.pop(sysid, None)
        self._udp_sock.pop(sysid, None)
        self._seen.discard(sysid)
        with self._link_lock:
            self._heard_on.pop(sysid, None)

    # --- commands -----------------------------------------------------------
    def arm(self, sysid: int, arm: bool = True) -> None:
        # A disarm fans out on a SYSID conflict (see _send_to); an arm never does.
        self._cmd_long(sysid, mav.MAV_CMD_COMPONENT_ARM_DISARM, 1.0 if arm else 0.0,
                       fanout=not arm)

    def force_arm(self, sysid: int) -> None:
        # param2 = 21196 is ArduPilot's "force arm" magic — bypasses the prearm
        # checks / failsafes and spins the motors. Dangerous; use deliberately.
        self._cmd_long(sysid, mav.MAV_CMD_COMPONENT_ARM_DISARM, 1.0, 21196.0)

    def force_disarm(self, sysid: int) -> None:
        """Kill the motors NOW, in flight if need be.

        ArduCopter refuses a plain disarm while flying (it checks for a landed
        state), so the same 21196 magic is required to force it. The aircraft
        will fall — that is what a kill switch is. Disarming also ends the
        mission, since AUTO cannot continue on a disarmed vehicle.
        """
        self._cmd_long(sysid, mav.MAV_CMD_COMPONENT_ARM_DISARM, 0.0, 21196.0, fanout=True)

    def takeoff(self, sysid: int, altitude: float) -> None:
        self._cmd_long(
            sysid, mav.MAV_CMD_NAV_TAKEOFF, 0, 0, 0, float("nan"), 0, 0, altitude
        )

    def set_mode(self, sysid: int, mode: str) -> bool:
        num = mode_number(mode)
        if num is None:
            return False
        self._cmd_long(
            sysid, mav.MAV_CMD_DO_SET_MODE,
            mav.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, float(num), 0,
        )
        return True

    def set_current(self, sysid: int, seq: int) -> None:
        """Jump the active mission to raw mission item `seq`."""
        m = self._tx_mav.mission_set_current_encode(sysid, 1, seq)
        self._send_encoded(sysid, m)

    def waypoint_seq(self, sysid: int, n: int) -> Optional[int]:
        """Operator waypoint number (1-based) -> mission item seq.

        None when there is no uploaded mission to map against, or the number is
        out of range. Guessing an offset here would be worse than refusing: the
        item layout depends on whether a takeoff and a DO_CHANGE_SPEED were
        included, so the same number means different things run to run.
        """
        seqs = self._wp_seq.get(sysid)
        if not seqs or n < 1 or n > len(seqs):
            return None
        return seqs[n - 1]

    def waypoint_count(self, sysid: int) -> int:
        return len(self._wp_seq.get(sysid, []))

    # --- acknowledged commands ----------------------------------------------
    # The senders above are fire-and-forget: fine for an operator pressing a
    # button and watching the status console, wrong for an automated sequence
    # where step N+1 must not run if the FC refused step N. These wait.

    async def _send_and_ack(
        self, sysid: int, command: int, *params: float, timeout: float = 3.0,
    ) -> Ack:
        """Send a COMMAND_LONG and wait for its COMMAND_ACK."""
        return await self._await_ack(
            sysid, command, lambda: self._cmd_long(sysid, command, *params), timeout,
        )

    async def _send_int_and_ack(
        self, sysid: int, frame: int, command: int,
        p1: float, p2: float, p3: float, p4: float,
        x: int, y: int, z: float, timeout: float = 3.0,
    ) -> Ack:
        """Send a COMMAND_INT and wait for its COMMAND_ACK."""
        return await self._await_ack(
            sysid, command,
            lambda: self._cmd_int(sysid, frame, command, p1, p2, p3, p4, x, y, z),
            timeout,
        )

    async def _await_ack(
        self, sysid: int, command: int, send: Callable[[], None], timeout: float,
    ) -> Ack:
        """Run `send`, then wait for the COMMAND_ACK of `command`.

        The queue is registered *before* the send so an ack that arrives while
        we are still setting up cannot be missed. MAV_RESULT_IN_PROGRESS is an
        interim report — keep waiting for the final verdict.
        """
        key = (sysid, int(command))
        q = self._waiter(self._ack_q, key)
        try:
            send()
            deadline = time.monotonic() + timeout
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return Ack(False, -1, "timeout")
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=remaining)
                except asyncio.TimeoutError:
                    return Ack(False, -1, "timeout")
                res = int(msg.result)
                if res == mav.MAV_RESULT_IN_PROGRESS:
                    continue
                return Ack(True, res, _result_name(res))
        finally:
            self._unwaiter(self._ack_q, key, q)

    async def set_safety_switch(
        self, sysid: int, dangerous: bool = True, timeout: float = 3.0,
    ) -> Ack:
        """Disengage (`dangerous=True`) or re-engage the safety switch.

        "Dangerous" is MAVLink's word for the switch being released, i.e. motor
        output permitted. Boards with no safety switch — and SITL — answer
        UNSUPPORTED; callers treat that as "nothing to do", not a failure.
        """
        state = (
            mav.SAFETY_SWITCH_STATE_DANGEROUS if dangerous
            else mav.SAFETY_SWITCH_STATE_SAFE
        )
        ack = await self._send_and_ack(
            sysid, mav.MAV_CMD_DO_SET_SAFETY_SWITCH_STATE, float(state), timeout=timeout,
        )
        if ack.ok:
            # Only a real ACCEPTED tells us the switch moved.
            self.registry.note_safety(sysid, engaged=not dangerous)
        elif ack.unsupported:
            # No switch on this board — record it, or the fail-safe default
            # would ground an aircraft that has nothing to release.
            self.registry.note_safety_unsupported(sysid)
        return ack

    def safety_engaged(self, sysid: int) -> Optional[bool]:
        """True = switch engaged (motors inhibited), None = unknown."""
        snap = self.registry.snapshot(sysid)
        return snap.health.safety_engaged if snap else None

    def bump_abort(self, sysid: int) -> None:
        """Cancel any long sequence running for this drone. Called by the
        emergency lane so a disarm is not quietly undone by a launch that was
        already half-way through arming."""
        self._abort_gen[sysid] = self._abort_gen.get(sysid, 0) + 1

    async def set_mode_ack(self, sysid: int, mode: str, timeout: float = 3.0) -> Ack:
        num = mode_number(mode)
        if num is None:
            return Ack(False, -1, f"unknown mode '{mode}'")
        return await self._send_and_ack(
            sysid, mav.MAV_CMD_DO_SET_MODE,
            float(mav.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED), float(num), 0.0,
            timeout=timeout,
        )

    async def arm_ack(
        self, sysid: int, arm: bool = True, force: bool = False, timeout: float = 5.0,
    ) -> Ack:
        return await self._send_and_ack(
            sysid, mav.MAV_CMD_COMPONENT_ARM_DISARM,
            1.0 if arm else 0.0, 21196.0 if force else 0.0,
            timeout=timeout,
        )

    # --- parameters ---------------------------------------------------------
    async def get_param(
        self, sysid: int, name: str, timeout: float = 2.0,
    ) -> Optional[float]:
        """Read one parameter. None on timeout (the FC may not have it at all)."""
        key = (sysid, name.upper())
        q = self._waiter(self._param_q, key)
        try:
            with self._send_lock:
                m = self._tx_mav.param_request_read_encode(
                    sysid, 1, name.encode("ascii")[:16], -1
                )
                data = m.pack(self._tx_mav)
            self._send_to(sysid, data)
            msg = await asyncio.wait_for(q.get(), timeout=timeout)
            return float(msg.param_value)
        except (asyncio.TimeoutError, RuntimeError):
            return None
        finally:
            self._unwaiter(self._param_q, key, q)

    async def get_params(
        self, sysid: int, names: List[str], timeout: float = 2.0,
    ) -> Dict[str, Optional[float]]:
        """Read several parameters concurrently."""
        results = await asyncio.gather(
            *(self.get_param(sysid, n, timeout) for n in names),
            return_exceptions=True,
        )
        out: Dict[str, Optional[float]] = {}
        for name, r in zip(names, results):
            out[name.upper()] = r if isinstance(r, float) else None
        return out

    async def set_param(
        self, sysid: int, name: str, value: float, timeout: float = 2.0,
    ) -> bool:
        """Write one parameter and confirm it stuck.

        ArduPilot echoes a PARAM_VALUE carrying the value it actually stored —
        which can differ from what we asked for (clamped to the param's range,
        or rejected outright), so the echo is compared rather than trusted.
        """
        key = (sysid, name.upper())
        q = self._waiter(self._param_q, key)
        try:
            with self._send_lock:
                m = self._tx_mav.param_set_encode(
                    sysid, 1, name.encode("ascii")[:16], float(value),
                    mav.MAV_PARAM_TYPE_REAL32,
                )
                data = m.pack(self._tx_mav)
            self._send_to(sysid, data)
            msg = await asyncio.wait_for(q.get(), timeout=timeout)
            stored = float(msg.param_value)
            if abs(stored - float(value)) > 1e-3:
                log.warning(
                    "sysid %d: %s set to %g but FC stored %g",
                    sysid, name, value, stored,
                )
                return False
            return True
        except (asyncio.TimeoutError, RuntimeError):
            log.warning("sysid %d: %s set timed out", sysid, name)
            return False
        finally:
            self._unwaiter(self._param_q, key, q)

    # --- speed --------------------------------------------------------------
    async def set_speed(self, sysid: int, speed_ms: float) -> Ack:
        """Change horizontal speed *now*, mid-flight.

        Unlike the DO_CHANGE_SPEED mission item (which is baked into the upload),
        this retargets the running mission immediately. ArduCopter applies it to
        the current leg; it is not persisted, so a fresh AUTO entry reverts to
        WPNAV_SPEED / whatever the mission's own item says.
        """
        a = await self._send_and_ack(
            sysid, mav.MAV_CMD_DO_CHANGE_SPEED,
            1.0, float(speed_ms), -1.0, 0.0, timeout=3.0,
        )
        if a.ok:
            # Keep the ride home, repositions and jumps at this speed too.
            await self._match_nav_speed(sysid, speed_ms)
        return a

    async def _match_nav_speed(self, sysid: int, speed_ms: float) -> str:
        """Make every leg the mission itself does not pace fly at the
        operator's speed: RTL, Reposition, and AUTO after a waypoint jump.

        DO_CHANGE_SPEED only lives as long as the AUTO session that ran it.
        ArduCopter's RTL re-initialises the navigator with RTL_SPEED (0, the
        default, means WPNAV_SPEED); GUIDED starts every reposition at
        WPNAV_SPEED (and DO_CHANGE_SPEED there only moves a secondary limit);
        and a jump that re-enters AUTO clears the override, while the mission's
        own speed item — at the start — is skipped. WPNAV_SPEED is 10 m/s out
        of the box, so all of those flew at 10 however slow the mission was.
        Both params are read live, so this takes effect mid-flight, and it
        covers failsafe RTLs too.

        Returns a suffix for the upload summary.
        """
        self._cruise_ms[sysid] = float(speed_ms)
        cms = round(float(speed_ms) * 100)
        missing = [
            name for name in ("WPNAV_SPEED", "RTL_SPEED")
            if not await self.set_param(sysid, name, cms)
        ]
        log.info("[speed] sysid %d: WPNAV_SPEED / RTL_SPEED = %d cm/s (%g m/s)%s",
                 sysid, cms, speed_ms, f" — FAILED: {', '.join(missing)}" if missing else "")
        if not missing:
            return f"; RTL / reposition / jumps at {speed_ms:g} m/s"
        return f"; WARNING {' and '.join(missing)} not set — those legs may fly at 10 m/s"

    async def _rtl_face_home(self, sysid: int) -> str:
        """Make every RTL fly home nose-first — the Return button and failsafes
        too, not just the mission's own ending (which turns in place first).

        WP_YAW_BEHAVIOR 2 (ArduCopter's default, "face next waypoint except
        RTL") holds the heading through RTL, so it comes home sideways or
        backwards. 1 is the same in every mode except that it faces home in
        RTL. Only the default is changed: 0 or 3 was chosen on purpose.
        Returns a suffix for the upload summary.
        """
        cur = await self.get_param(sysid, "WP_YAW_BEHAVIOR")
        if cur is None:
            return "; WARNING WP_YAW_BEHAVIOR unreadable — RTL may not face home"
        if round(cur) == 1:
            return ""
        if round(cur) != 2:
            return f"; WP_YAW_BEHAVIOR={cur:g} left as set — RTL may not face home"
        if await self.set_param(sysid, "WP_YAW_BEHAVIOR", 1):
            return "; RTL faces home"
        return "; WARNING WP_YAW_BEHAVIOR not set — RTL may not face home"

    # --- geofence -----------------------------------------------------------
    FENCE_PARAMS = ["FENCE_ENABLE", "FENCE_RADIUS", "FENCE_ALT_MAX",
                    "FENCE_ACTION", "FENCE_MARGIN"]

    async def get_fence(self, sysid: int) -> dict:
        """Read the fence back off the FC so the map draws what is really set,
        not what we last asked for."""
        v = await self.get_params(sysid, self.FENCE_PARAMS, timeout=2.0)
        enable = v.get("FENCE_ENABLE")
        return {
            "type": "fence",
            "sysid": sysid,
            "known": enable is not None,
            "enabled": bool(enable) if enable is not None else False,
            "radius": v.get("FENCE_RADIUS"),
            "alt_max": v.get("FENCE_ALT_MAX"),
            "action": int(v["FENCE_ACTION"]) if v.get("FENCE_ACTION") is not None else None,
            "margin": v.get("FENCE_MARGIN"),
        }

    async def set_fence(
        self, sysid: int, radius_m: float, alt_max_m: float,
        action: int = 1, enable: bool = True,
    ) -> tuple[bool, str]:
        """Configure and enable the cylindrical geofence around home.

        action 1 = RTL-or-LAND, which is what a search aircraft wants: leaving
        the box returns it rather than cutting motors. FENCE_TYPE 3 = altitude +
        circle. Written before ENABLE so the fence never switches on with stale
        limits still in place.
        """
        steps = [
            ("FENCE_TYPE", 3.0),
            ("FENCE_RADIUS", float(radius_m)),
            ("FENCE_ALT_MAX", float(alt_max_m)),
            ("FENCE_ACTION", float(action)),
            ("FENCE_ENABLE", 1.0 if enable else 0.0),
        ]
        failed: List[str] = []
        for name, value in steps:
            if not await self.set_param(sysid, name, value):
                failed.append(name)
        if failed:
            return False, f"could not set {', '.join(failed)}"
        return True, (
            f"fence {'on' if enable else 'off'} — r={radius_m:g} m, "
            f"alt≤{alt_max_m:g} m, action={action}"
        )

    # --- preflight ----------------------------------------------------------
    async def preflight(self, sysid: int) -> PreflightResult:
        """Is this aircraft fit to fly *right now*?

        1. our own telemetry thresholds — a fast local pre-screen;
        2. the FC's own prearm verdict, forced fresh with RUN_PREARM_CHECKS and
           quoted back with the reasons it emits as "PreArm: ..." text.

        Layer 2 decides whether the aircraft will actually arm; layer 1 exists to
        tell the operator why before they try. Failsafe *configuration* is a
        separate question — see get_failsafe / set_failsafe.
        """
        snap = self.registry.snapshot(sysid)
        if snap is None:
            return PreflightResult(
                sysid, False, [PreflightCheck("telemetry", False, "no data from drone")]
            )

        prearm_task = asyncio.create_task(self._run_prearm(sysid))

        checks: List[PreflightCheck] = []
        checks.append(PreflightCheck("Heartbeat", snap.connected,
                                     "receiving" if snap.connected else "stale link"))
        fix = snap.gps.fixtype or 0
        checks.append(PreflightCheck("GPS fix", fix >= 3, f"fix type {fix}"))
        sats = snap.gps.satellites or 0
        checks.append(PreflightCheck("Satellites", sats >= 6, f"{sats} visible"))
        hdop = snap.gps.hdop if snap.gps.hdop is not None else 99.0
        checks.append(PreflightCheck("HDOP", hdop < 1.5, f"{hdop:.2f}"))
        lvl = snap.battery.level
        checks.append(PreflightCheck("Battery", lvl is None or lvl > 25,
                                     f"{lvl}%" if lvl is not None else "n/a"))
        pos_ok = snap.navigation.latitude is not None
        checks.append(PreflightCheck("Position", pos_ok,
                                     "locked" if pos_ok else "no position"))

        checks.extend(await prearm_task)
        ok = all(c.ok for c in checks)
        return PreflightResult(sysid, ok, checks)

    # --- failsafe configuration ---------------------------------------------
    # Deliberately short: what the aircraft should DO when something goes wrong.
    # Separate from preflight, which asks whether it is fit to fly right now.
    FAILSAFE_PARAMS = [
        "BATT_FS_LOW_ACT",   # action on low battery
        "BATT_LOW_VOLT",     # the voltage that counts as low
        "BATT_FS_CRT_ACT",   # action on critical battery
        "FS_GCS_ENABLE",     # action on GCS link loss
        "FS_THR_ENABLE",     # action on RC link loss
        "FS_EKF_ACTION",     # action when the state estimate diverges
    ]

    async def get_failsafe(self, sysid: int) -> dict:
        values = await self.get_params(sysid, self.FAILSAFE_PARAMS, timeout=2.0)
        return {"type": "failsafe", "sysid": sysid, "values": values}

    async def set_failsafe(self, sysid: int, values: dict) -> tuple[bool, str]:
        """Write only the parameters the operator actually changed."""
        wanted = {k.upper(): v for k, v in values.items()
                  if k.upper() in self.FAILSAFE_PARAMS and v is not None}
        if not wanted:
            return False, "nothing to set"
        failed = [n for n in wanted if not await self.set_param(sysid, n, float(wanted[n]))]
        if failed:
            return False, f"could not set {', '.join(failed)}"
        return True, f"set {', '.join(sorted(wanted))}"

    async def _run_prearm(self, sysid: int, settle: float = 2.0) -> List[PreflightCheck]:
        """Ask the FC to run its real prearm checks and report the verdict.

        RUN_PREARM_CHECKS is acked merely to say "I ran them" — the ACK carries
        no pass/fail. The verdict is the SYS_STATUS prearm bit; the *reasons*
        arrive separately as "PreArm: ..." STATUSTEXT, which the aggregator
        keeps for us. So: fire, let it settle, then read both.
        """
        out: List[PreflightCheck] = []
        ack = await self._send_and_ack(
            sysid, mav.MAV_CMD_RUN_PREARM_CHECKS, 0.0, timeout=2.0,
        )
        if not (ack.ok or ack.unsupported):
            log.info("sysid %d: RUN_PREARM_CHECKS %s", sysid, ack.name)
        await asyncio.sleep(settle)

        snap = self.registry.snapshot(sysid)
        health = snap.health if snap else None
        if health is None or health.prearm_ok is None:
            out.append(PreflightCheck(
                "FC prearm", False, "flight controller has not reported it",
            ))
        else:
            reasons = "; ".join(health.prearm_messages) if health.prearm_messages else ""
            out.append(PreflightCheck(
                "FC prearm",
                health.prearm_ok,
                "ready to arm" if health.prearm_ok else (reasons or "blocked (no reason given)"),
            ))
        if health is not None:
            if health.unhealthy:
                out.append(PreflightCheck(
                    "Sensors", False, f"unhealthy: {', '.join(health.unhealthy)}",
                ))
            else:
                out.append(PreflightCheck("Sensors", True, "all healthy"))
            out.append(PreflightCheck(
                "Failsafe state",
                not health.failsafe,
                health.system_status if health.failsafe else f"{health.system_status}, clear",
            ))
        return out

    # --- mission upload -----------------------------------------------------
    async def upload_mission(
        self, sysid: int, waypoints: List[dict], progress: ProgressCb,
        default_alt: float = 15.0, takeoff_alt: float | None = None,
        speed: float | None = None, finish: str = "rtl",
    ) -> bool:
        """Upload a list of {lat,lon,alt?,hold?} waypoints via the MAVLink mission
        protocol. Seq 0 is a home placeholder (ArduPilot overwrites it). When
        takeoff_alt is set, a NAV_TAKEOFF is inserted as the first command so an
        AUTO mission can launch from the ground. When `speed` (m/s) is set, a
        DO_CHANGE_SPEED is inserted after the climb so the cruise legs run at
        that speed instead of the FC's WPNAV_SPEED default (10 m/s).

        Headings are planned too: at the top of the climb, and at every corner
        of TURN_MIN_DEG or more, the aircraft hovers, turns on the spot to face
        the next waypoint, then flies the leg nose-first.

        `finish` decides how the mission ends:
          "rtl"  -> NAV_RETURN_TO_LAUNCH  (default; comes home)
          "land" -> NAV_LAND at the last waypoint
          "hold" -> nothing appended. ArduCopter then loiters at the final
                    waypoint until a mode change, a disarm or a failsafe — so
                    with no battery failsafe set it hovers until the pack is
                    flat. Valid for a camera parked over a survivor, but it has
                    to be asked for.
        """
        if sysid not in self._route:
            await progress(MissionProgress(sysid, "failed", 0, 0, "drone not seen"))
            return False

        snap = self.registry.snapshot(sysid)
        home_lat = (snap.navigation.latitude if snap else None) or 0.0
        home_lon = (snap.navigation.longitude if snap else None) or 0.0

        items: List[dict] = [
            {"lat": home_lat, "lon": home_lon, "alt": 0.0, "command": mav.MAV_CMD_NAV_WAYPOINT}
        ]
        if takeoff_alt is not None:
            # NAV_TAKEOFF ignores lat/lon and just climbs to alt in place.
            items.append(
                {"lat": 0.0, "lon": 0.0, "alt": float(takeoff_alt), "command": mav.MAV_CMD_NAV_TAKEOFF}
            )
        if speed is not None and speed > 0:
            # Placed AFTER the climb so it governs the cruise legs only — the
            # takeoff is bounded by WPNAV_SPEED_UP and is not affected. It is a
            # DO_ command, so it fires the moment the mission reaches it rather
            # than counting as a destination.
            #   p1 = 1  -> ground speed (Copter maps 0 and 1 to horizontal)
            #   p2 = m/s
            #   p3 = -1 -> leave throttle alone
            items.append({
                "lat": 0.0, "lon": 0.0, "alt": 0.0,
                "command": mav.MAV_CMD_DO_CHANGE_SPEED,
                "p1": 1.0, "p2": float(speed), "p3": -1.0, "p4": 0.0,
            })
        # Turn-then-fly (see TURN_MIN_DEG). ArduPilot starts the DO/CONDITION
        # commands after a nav command only once that nav command is COMPLETE,
        # alongside the next one — so a turn placed after a waypoint would run
        # on the next leg. Each turn therefore gets its own stop: CONDITION_YAW
        # followed by a hover waypoint on the same spot, held long enough for
        # the turn, and only then the leg.
        pts = [(float(w["lat"]), float(w["lon"])) for w in waypoints]
        # The heading it will arrive with at the next point. NAV_TAKEOFF climbs
        # without turning, so at first that is the heading it sits at now.
        facing: Optional[float] = snap.navigation.heading if snap else None
        turns = 0

        def turn_stop(to: float, lat: float, lon: float, alt: float) -> None:
            """Turn in place to `to`, if the turn is big enough to matter."""
            nonlocal turns
            # Unknown current heading: plan for the worst case, a full 180.
            need = 180.0 if facing is None else _turn_deg(facing, to)
            if need < TURN_MIN_DEG:
                return
            items.append(_yaw_item(to))
            items.append({
                "lat": lat, "lon": lon, "alt": alt,
                "command": mav.MAV_CMD_NAV_WAYPOINT,
                # The next leg starts when this hold ends, turned or not.
                # (rounded first: a 90.02° corner should not cost a whole second)
                "p1": float(math.ceil(round(need / TURN_RATE_DPS + TURN_SETTLE_SEC, 1))),
            })
            turns += 1

        if (takeoff_alt is not None and (home_lat or home_lon) and pts
                and _dist_m(home_lat, home_lon, *pts[0]) >= TURN_MIN_LEG_M):
            # Face waypoint 1 at the top of the climb. lat/lon 0 = "where you
            # are" to ArduCopter, so this hovers wherever it actually lifted off.
            to = _bearing_deg(home_lat, home_lon, *pts[0])
            turn_stop(to, 0.0, 0.0, float(takeoff_alt))
            facing = to
        face_first = turns > 0

        wp_seqs: List[int] = []
        for i, wp in enumerate(waypoints):
            command = int(wp.get("command", mav.MAV_CMD_NAV_WAYPOINT))
            alt = float(wp.get("alt", default_alt))
            wp_seqs.append(len(items))   # this waypoint's mission item number
            items.append({
                "lat": pts[i][0],
                "lon": pts[i][1],
                "alt": alt,
                "command": command,
                # NAV_WAYPOINT param1 is the hold time in seconds.
                "p1": float(wp.get("hold", 0) or 0),
            })
            if i + 1 < len(pts) and _dist_m(*pts[i], *pts[i + 1]) >= TURN_MIN_LEG_M:
                to = _bearing_deg(*pts[i], *pts[i + 1])
                if command == mav.MAV_CMD_NAV_WAYPOINT:
                    turn_stop(to, pts[i][0], pts[i][1], alt)
                facing = to

        # Terminal command — what happens when the last waypoint is reached.
        fin = (finish or "rtl").lower()
        if fin not in ("rtl", "land", "hold"):
            log.warning("sysid %d: unknown finish %r — defaulting to RTL", sysid, finish)
            fin = "rtl"
        face_home = False
        if (fin == "rtl" and (home_lat or home_lon) and pts
                and int(waypoints[-1].get("command", mav.MAV_CMD_NAV_WAYPOINT)) == mav.MAV_CMD_NAV_WAYPOINT
                and _dist_m(*pts[-1], home_lat, home_lon) >= TURN_MIN_LEG_M):
            # RTL holds whatever heading it starts with (and only climbs
            # straight up first), so turn to face home here and it flies the
            # whole way back nose-first.
            before = turns
            turn_stop(
                _bearing_deg(*pts[-1], home_lat, home_lon),
                pts[-1][0], pts[-1][1], float(waypoints[-1].get("alt", default_alt)),
            )
            face_home = turns > before
        if fin == "rtl":
            items.append({
                "lat": 0.0, "lon": 0.0, "alt": 0.0,
                "command": mav.MAV_CMD_NAV_RETURN_TO_LAUNCH,
            })
        elif fin == "land":
            # lat/lon 0 = land where it is, i.e. at the final waypoint.
            items.append({
                "lat": 0.0, "lon": 0.0, "alt": 0.0,
                "command": mav.MAV_CMD_NAV_LAND,
            })
        else:
            log.warning(
                "sysid %d: mission has NO terminal command — the aircraft will "
                "hold at the last waypoint until a failsafe or the operator acts",
                sysid,
            )
        count = len(items)

        # What the operator should read on success: their waypoints, and why the
        # item count is larger than that.
        extras = ["home"]
        if takeoff_alt is not None:
            extras.append("takeoff")
        if speed is not None and speed > 0:
            extras.append("speed")
        if face_first:
            extras.append("face WP1")
        corners = turns - face_first - face_home
        if corners:
            extras.append(f"{corners} corner turn{'s' if corners != 1 else ''}")
        if face_home:
            extras.append("face home")
        if fin != "hold":
            extras.append("land" if fin == "land" else "RTL")
        summary = (
            f"{len(waypoints)} waypoint{'s' if len(waypoints) != 1 else ''} "
            f"+ {', '.join(extras)} = {count} items"
        )

        def ours(m) -> bool:
            """A protocol message for THIS upload: the plain mission (not fence
            or rally) and, for acks, addressed to us rather than another GCS or
            a companion computer."""
            if int(getattr(m, "mission_type", mav.MAV_MISSION_TYPE_MISSION)) != mav.MAV_MISSION_TYPE_MISSION:
                return False
            if m.get_type() == "MISSION_ACK":
                return int(getattr(m, "target_system", 0)) in (0, self._tx_mav.srcSystem)
            return True

        q: asyncio.Queue = asyncio.Queue()
        self._mission_q[sysid] = q
        sent: set[int] = set()
        last_sent = -1                   # seq of the item we sent most recently
        sent_at: Dict[int, float] = {}   # seq -> when we sent it
        count_tries = 0
        try:
            # No MISSION_CLEAR_ALL first. MISSION_COUNT already replaces the
            # whole mission, and the clear's own MISSION_ACK was the bug: over a
            # radio it arrived after the old 0.15 s drain, was taken as the
            # upload's verdict ("complete (0/6) accepted"), and the GCS stopped
            # answering while the FC — mission now EMPTY — waited for item 0.
            count_msg = self._tx_mav.mission_count_encode(sysid, 1, count)
            self._send_encoded(sysid, count_msg)
            await progress(MissionProgress(sysid, "uploading", 0, count))

            while True:
                wait = MISSION_COUNT_RETRY_SEC if not sent else MISSION_ITEM_TIMEOUT_SEC
                try:
                    first = await asyncio.wait_for(q.get(), timeout=wait)
                except asyncio.TimeoutError:
                    # Nothing asked for yet: the MISSION_COUNT itself was lost.
                    if not sent and count_tries < MISSION_COUNT_RETRIES:
                        count_tries += 1
                        log.info("mission sysid %d: no request yet — resending count (%d)",
                                 sysid, count_tries)
                        self._send_encoded(sysid, count_msg)
                        continue
                    raise
                batch = [first]
                while not q.empty():
                    batch.append(q.get_nowait())
                batch = [m for m in batch if ours(m)]

                log.info(
                    "mission sysid %d rx: %s",
                    sysid,
                    [(m.get_type().replace("MISSION_", ""), getattr(m, "seq", "")) for m in batch],
                )

                # A MISSION_ACK ends the upload — but an ACCEPTED can only be the
                # verdict once the last item is out. Earlier than that it belongs
                # to some other transaction and is ignored; an error ack is taken
                # at any point (the FC may refuse the count outright).
                verdict = None
                for ack in (m for m in batch if m.get_type() == "MISSION_ACK"):
                    res = int(getattr(ack, "type", -1))
                    if res == mav.MAV_MISSION_ACCEPTED and last_sent < count - 1:
                        log.info("mission sysid %d: ignoring early ACCEPTED (%d/%d sent)",
                                 sysid, len(sent), count)
                        continue
                    verdict = res
                    break
                if verdict is not None:
                    ok = verdict == mav.MAV_MISSION_ACCEPTED
                    res_enum = mavutil.mavlink.enums.get("MAV_MISSION_RESULT", {})
                    name = (
                        res_enum[verdict].name.replace("MAV_MISSION_", "")
                        if verdict in res_enum else f"code {verdict}"
                    )
                    log.info("mission sysid %d result: %s (%d/%d)", sysid, name, len(sent), count)
                    note = ""
                    if ok:
                        # Only trust the mapping for a mission the FC accepted.
                        self._wp_seq[sysid] = wp_seqs
                        self._wp_pts[sysid] = pts
                        if speed is not None and speed > 0:
                            note = await self._match_nav_speed(sysid, speed)
                        note += await self._rtl_face_home(sysid)
                    await progress(MissionProgress(
                        sysid, "complete" if ok else "failed", len(sent), count,
                        f"accepted — {summary}{note}" if ok else f"rejected: {name}",
                    ))
                    return ok

                # ArduPilot asks in strict order and re-asks every ~1 s until it
                # gets the item, so the HIGHEST queued seq is its current ask.
                reqs = [
                    int(getattr(m, "seq", -1))
                    for m in batch
                    if m.get_type() in ("MISSION_REQUEST_INT", "MISSION_REQUEST")
                ]
                reqs = [s for s in reqs if 0 <= s < count]
                if not reqs:
                    continue
                seq = max(reqs)
                now = time.monotonic()
                if seq < last_sent:
                    continue  # stale: the FC has already moved past this item
                if seq == last_sent and now - sent_at[seq] < MISSION_RESEND_MIN_SEC:
                    # Same request arriving twice at once (double-forwarded
                    # SITL). Answering it again made the FC reject the upload.
                    log.info("mission sysid %d: dropped duplicate request for %d", sysid, seq)
                    continue
                if seq == last_sent:
                    # The FC's retry: our item never arrived. Over a radio this
                    # is normal, and ignoring it stalled the upload for good.
                    log.info("mission sysid %d: item %d lost — resending", sysid, seq)
                last_sent = seq
                sent_at[seq] = now
                self._send_mission_item(sysid, seq, items[seq])
                sent.add(seq)
                log.info("mission sysid %d: FC asked %s -> sent item %d", sysid, reqs, seq)
                await progress(MissionProgress(sysid, "uploading", len(sent), count))
        except asyncio.TimeoutError:
            detail = (
                "timeout — no reply to the mission count (is the drone linked?)"
                if not sent else
                "timeout — link lost mid-upload; the drone's mission is now "
                "incomplete, upload again"
            )
            await progress(MissionProgress(sysid, "failed", len(sent), count, detail))
            return False
        finally:
            if self._mission_q.get(sysid) is q:
                self._mission_q.pop(sysid, None)

    def _send_mission_item(self, sysid: int, seq: int, it: dict) -> None:
        # p1..p4 default to 0, which is what plain NAV_WAYPOINTs want (param1 is
        # hold time). DO_ commands carry their arguments here instead of lat/lon.
        m = self._tx_mav.mission_item_int_encode(
            sysid, 1, seq,
            mav.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT, it["command"],
            0, 1,
            float(it.get("p1", 0.0)), float(it.get("p2", 0.0)),
            float(it.get("p3", 0.0)), float(it.get("p4", 0.0)),
            int(it["lat"] * 1e7), int(it["lon"] * 1e7), it["alt"],
        )
        self._send_encoded(sysid, m)

    async def _wait_armed(self, sysid: int, timeout: float = 5.0) -> bool:
        for _ in range(max(1, int(timeout / 0.2))):
            snap = self.registry.snapshot(sysid)
            if snap and snap.armed:
                return True
            await asyncio.sleep(0.2)
        return False

    async def _wait_mode(self, sysid: int, mode: str, timeout: float = 3.0) -> bool:
        """Confirm the FC actually *entered* a mode. An ACCEPTED ack only says the
        request was taken; HEARTBEAT.custom_mode is the ground truth."""
        want = mode.upper()
        for _ in range(max(1, int(timeout / 0.2))):
            snap = self.registry.snapshot(sysid)
            if snap and (snap.mode or "").upper() == want:
                return True
            await asyncio.sleep(0.2)
        return False

    async def start_mission(
        self, sysid: int, waypoints: List[dict], progress: ProgressCb,
        cruise_alt: float = 15.0, takeoff_alt: float = 10.0,
        speed: float | None = None, finish: str = "rtl",
    ) -> tuple[bool, str]:
        """One-shot AUTO mission launch, strictly sequenced:

            upload -> GUIDED -> ARM -> AUTO -> MISSION_START

        Every step waits for the flight controller's own COMMAND_ACK before the
        next is sent, and mode/arm are additionally confirmed against HEARTBEAT,
        so we can never arm into a mode change the FC actually refused.

        The safety switch is the OPERATOR'S, not ours. This refuses to launch
        while it is on rather than releasing it on their behalf: the whole point
        of that switch is that a human decides when the props may spin, so
        automation must never move it. Turning it off is a separate, deliberate
        click.

        If a later step fails once the aircraft is armed, the sequence rolls back
        by disarming. It does not touch the safety switch on the way out either.
        """
        if not waypoints:
            return False, "no waypoints drawn"

        # Refuse up front — before the upload — so a launch that cannot proceed
        # does not first rewrite the mission on the aircraft.
        if self.safety_engaged(sysid) is not False:
            return False, "safety switch is ON — turn it OFF before starting a mission"

        abort_gen = self._abort_gen.get(sysid, 0)

        def cancelled() -> bool:
            return self._abort_gen.get(sysid, 0) != abort_gen

        ok = await self.upload_mission(
            sysid, waypoints, progress, default_alt=cruise_alt,
            takeoff_alt=takeoff_alt, speed=speed, finish=finish,
        )
        if not ok:
            return False, "mission upload failed"
        await asyncio.sleep(0.3)

        armed = False

        async def rollback(why: str) -> None:
            """Leave the aircraft no more live than we found it. Never raises —
            a failure here must not mask the failure that triggered it."""
            try:
                if armed:
                    log.warning("start_mission sysid %d: %s — disarming", sysid, why)
                    await self.arm_ack(sysid, False, timeout=3.0)
            except Exception:
                log.exception("start_mission sysid %d: rollback failed", sysid)

        # Checked before every step: an emergency command (disarm, safety ON)
        # bumps the generation, and without this the sequence would carry on and
        # re-arm the aircraft a second after the operator stopped it.
        if cancelled():
            return False, "cancelled by operator"

        # 1. GUIDED.
        ack = await self.set_mode_ack(sysid, "GUIDED")
        if not ack.ok:
            return False, f"GUIDED refused: {ack.name}"
        if not await self._wait_mode(sysid, "GUIDED"):
            return False, "GUIDED acked but the FC never entered it"
        if cancelled():
            return False, "cancelled by operator"

        # 2. Arm.
        ack = await self.arm_ack(sysid, True)
        if not ack.ok:
            return False, f"arm refused: {ack.name} (check prearm)"
        if not await self._wait_armed(sysid, 5.0):
            return False, "arm acked but HEARTBEAT never reported armed"
        armed = True
        if cancelled():
            await rollback("cancelled by operator")
            return False, "cancelled by operator"

        # 3. AUTO.
        ack = await self.set_mode_ack(sysid, "AUTO")
        if not ack.ok:
            await rollback("AUTO refused")
            return False, f"AUTO refused: {ack.name}"
        if not await self._wait_mode(sysid, "AUTO"):
            await rollback("AUTO not entered")
            return False, "AUTO acked but the FC never entered it"
        if cancelled():
            await rollback("cancelled by operator")
            return False, "cancelled by operator"

        # 4. Run it.
        ack = await self._send_and_ack(sysid, mav.MAV_CMD_MISSION_START, 0.0, 0.0)
        if not ack.ok:
            await rollback("MISSION_START refused")
            return False, f"MISSION_START refused: {ack.name}"

        log.info("start_mission sysid %d: AUTO mission running", sysid)
        return True, "AUTO mission started"

    # --- turn-then-fly for Reposition and Jump ------------------------------
    # The upload already stops and turns in place at every corner it planned.
    # A reposition or a jump opens a leg the upload never saw, so ArduCopter
    # would swing the nose round at full yaw rate while already accelerating
    # down it. These do the same stop -> turn -> fly, live.

    def _new_maneuver(self, sysid: int) -> Callable[[], Optional[str]]:
        """Start a maneuver. Returns a check giving the reason it must stop
        now, or None to carry on. Any newer reposition/jump supersedes it."""
        gen = self._maneuver_gen.get(sysid, 0) + 1
        self._maneuver_gen[sysid] = gen
        abort = self._abort_gen.get(sysid, 0)

        def stop_reason() -> Optional[str]:
            if self._abort_gen.get(sysid, 0) != abort:
                return "cancelled by operator"
            if self._maneuver_gen.get(sysid, 0) != gen:
                return "replaced by a newer command"
            snap = self.registry.snapshot(sysid)
            if snap is None or not snap.armed:
                return "aircraft disarmed"
            # Only ever run in GUIDED. If the operator picked another mode
            # (RTL, LAND, LOITER…) mid-turn, theirs wins — never switch back.
            if (snap.mode or "").upper() != "GUIDED":
                return f"mode changed to {snap.mode}"
            return None

        return stop_reason

    def _speed_note(self, sysid: int) -> str:
        sp = self._cruise_ms.get(sysid)
        return f" at {sp:g} m/s" if sp else " at the FC's WPNAV_SPEED (no cruise speed applied yet)"

    async def _reposition_ack(self, sysid: int, lat: float, lon: float, alt: float) -> Ack:
        """GUIDED: fly to a point (alt relative to home). COMMAND_INT keeps the
        lat/lon precision that float32 COMMAND_LONG params would lose."""
        return await self._send_int_and_ack(
            sysid, mav.MAV_FRAME_GLOBAL_RELATIVE_ALT, mav.MAV_CMD_DO_REPOSITION,
            -1, 0, 0, float("nan"),
            int(lat * 1e7), int(lon * 1e7), alt,
        )

    async def _hold_here(self, sysid: int) -> Ack:
        """GUIDED: stop at the current position and altitude."""
        nav = self.registry.snapshot(sysid).navigation
        return await self._reposition_ack(
            sysid, nav.latitude, nav.longitude, float(nav.altitude or 0.0),
        )

    async def _stop_and_face(
        self, sysid: int, lat: float, lon: float, stop_reason: Callable[[], Optional[str]],
    ) -> Optional[str]:
        """GUIDED: come to a stop, then turn on the spot to face (lat, lon).

        Returns None once it faces the target — or when no turn is needed —
        otherwise the reason it gave up.
        """
        snap = self.registry.snapshot(sysid)
        nav = snap.navigation if snap else None
        if nav is None or nav.latitude is None or nav.longitude is None:
            log.info("[turn] sysid %d: no position — skipping the turn", sysid)
            return None  # no position to plan a turn from; fly as before
        d = _dist_m(nav.latitude, nav.longitude, lat, lon)
        if d < TURN_MIN_LEG_M:
            log.info("[turn] sysid %d: target only %.1f m away — no turn", sysid, d)
            return None
        to = _bearing_deg(nav.latitude, nav.longitude, lat, lon)
        log.info("[turn] sysid %d: target %.0f m away, bearing %.0f°; now heading %s°, %.1f m/s",
                 sysid, d, to, nav.heading, nav.groundspeed or 0.0)
        if nav.heading is not None and _turn_deg(nav.heading, to) < TURN_MIN_DEG:
            log.info("[turn] sysid %d: already facing it (%.0f° off) — no turn",
                     sysid, _turn_deg(nav.heading, to))
            return None

        # 1. Stop. Otherwise the turn happens while it is still flying the old
        #    leg — the very swing this is here to prevent.
        if (nav.groundspeed or 0.0) > STOPPED_MS:
            ack = await self._hold_here(sysid)
            log.info("[turn] sysid %d: brake (hold here) -> %s", sysid, ack.name)
            if not ack.ok:
                return f"brake refused: {ack.name}"
            t0 = time.monotonic()
            deadline = t0 + BRAKE_TIMEOUT_SEC
            while True:
                await asyncio.sleep(0.2)
                why = stop_reason()
                if why:
                    log.info("[turn] sysid %d: stopped while braking — %s", sysid, why)
                    return why
                s = self.registry.snapshot(sysid)
                if s and (s.navigation.groundspeed or 0.0) <= STOPPED_MS:
                    log.info("[turn] sysid %d: stopped after %.1f s", sysid, time.monotonic() - t0)
                    break
                if time.monotonic() > deadline:
                    log.warning("[turn] sysid %d: still moving after %gs of braking — turning anyway",
                                sysid, BRAKE_TIMEOUT_SEC)
                    break
            # The brake point was where it was when braking began, so it would
            # now fly back to it. Hold where it actually stopped instead.
            ack = await self._hold_here(sysid)
            log.info("[turn] sysid %d: hold where it stopped -> %s", sysid, ack.name)
        else:
            log.info("[turn] sysid %d: already stopped — no brake needed", sysid)

        # 2. Turn on the spot, at the same rate as the mission's corner turns.
        why = stop_reason()
        if why:
            log.info("[turn] sysid %d: stopped before the turn — %s", sysid, why)
            return why
        s = self.registry.snapshot(sysid)
        heading = s.navigation.heading if s else None
        ack = await self._send_and_ack(
            sysid, mav.MAV_CMD_CONDITION_YAW, round(to, 1), TURN_RATE_DPS, 0.0, 0.0,
        )
        log.info("[turn] sysid %d: CONDITION_YAW %s° -> %.0f° at %g°/s -> %s",
                 sysid, heading, to, TURN_RATE_DPS, ack.name)
        if not ack.ok:
            return f"turn refused: {ack.name}"
        t_turn = time.monotonic()
        need = 180.0 if heading is None else _turn_deg(heading, to)
        # Generous: the FC's own yaw limits may turn slower than asked.
        deadline = time.monotonic() + need / TURN_RATE_DPS + TURN_SETTLE_SEC + 3.0
        while True:
            await asyncio.sleep(0.1)
            why = stop_reason()
            if why:
                log.info("[turn] sysid %d: stopped mid-turn — %s", sysid, why)
                return why
            s = self.registry.snapshot(sysid)
            h = s.navigation.heading if s else None
            if h is not None and _turn_deg(h, to) <= TURN_DONE_DEG:
                log.info("[turn] sysid %d: facing %.0f° (heading %s°) after %.1f s",
                         sysid, to, h, time.monotonic() - t_turn)
                break
            if time.monotonic() > deadline:
                log.warning("[turn] sysid %d: turn to %.0f° not finished in time (heading %s°) — flying anyway",
                            sysid, to, h)
                break
        # Let the nose settle before the leg starts.
        await asyncio.sleep(TURN_SETTLE_SEC / 2)
        return stop_reason()

    async def fly_to(self, sysid: int, lat: float, lon: float, alt: float) -> tuple[bool, str]:
        """Reposition, turn-then-fly: stop, face the target, then fly there.

        ArduCopter only accepts DO_REPOSITION in GUIDED, so this refuses in any
        other mode rather than sending a command the FC will drop. The leg is
        flown at WPNAV_SPEED, which _match_nav_speed keeps at the operator's
        cruise speed.
        """
        stop_reason = self._new_maneuver(sysid)
        snap = self.registry.snapshot(sysid)
        mode = (snap.mode if snap else None) or "unknown"
        log.info("[reposition] sysid %d: to %.7f, %.7f @ %.1f m (mode %s, cruise %s m/s)",
                 sysid, lat, lon, alt, mode, self._cruise_ms.get(sysid))
        if mode.upper() != "GUIDED":
            log.info("[reposition] sysid %d: refused — not in GUIDED", sysid)
            return False, (
                f"refused — reposition only works in GUIDED (drone is in {mode}). "
                "Switch mode to GUIDED, then click again."
            )
        why = await self._stop_and_face(sysid, lat, lon, stop_reason)
        if why:
            log.info("[reposition] sysid %d: stopped — %s", sysid, why)
            return False, f"reposition stopped: {why}"
        ack = await self._reposition_ack(sysid, lat, lon, alt)
        log.info("[reposition] sysid %d: DO_REPOSITION to target -> %s", sysid, ack.name)
        if not ack.ok:
            return False, f"reposition refused: {ack.name}"
        return True, f"flying to target{self._speed_note(sysid)}"

    async def _set_current_ack(self, sysid: int, seq: int) -> bool:
        """Set the mission's current item, confirmed where the FC can say so."""
        ack = await self._send_and_ack(
            sysid, mav.MAV_CMD_DO_SET_MISSION_CURRENT, float(seq), 0.0, timeout=2.0,
        )
        log.info("[jump] sysid %d: DO_SET_MISSION_CURRENT %d -> %s", sysid, seq, ack.name)
        if ack.ok:
            return True
        if ack.received and not ack.unsupported:
            return False
        # Older firmware has no command form; the plain message is unacked.
        log.info("[jump] sysid %d: falling back to MISSION_SET_CURRENT %d (no ack)", sysid, seq)
        self.set_current(sysid, seq)
        return True

    async def jump_to(self, sysid: int, n: int, seq: int) -> tuple[bool, str]:
        """Jump to waypoint `n` (mission item `seq`), turn-then-fly.

        In AUTO, a bare MISSION_SET_CURRENT flies straight at the new waypoint
        and swings the nose round on the way. Instead: GUIDED (which brakes to
        a stop by itself), turn on the spot to face the waypoint, set it as
        current, then AUTO again — which resumes from it, nose already on.

        If anything fails part-way the aircraft is left holding in GUIDED —
        hovering, never resuming a leg the operator did not ask for.
        """
        label = f"jump to waypoint {n}"
        stop_reason = self._new_maneuver(sysid)
        snap = self.registry.snapshot(sysid)
        in_auto = bool(snap and snap.armed and (snap.mode or "").upper() == "AUTO")
        pts = self._wp_pts.get(sysid) or []
        target = pts[n - 1] if 0 < n <= len(pts) else None
        nav = snap.navigation if snap else None

        needs_turn = (
            in_auto and target is not None and nav is not None
            and nav.latitude is not None and nav.longitude is not None
            and _dist_m(nav.latitude, nav.longitude, *target) >= TURN_MIN_LEG_M
            and (nav.heading is None
                 or _turn_deg(nav.heading, _bearing_deg(nav.latitude, nav.longitude, *target))
                 >= TURN_MIN_DEG)
        )
        log.info("[jump] sysid %d: to WP %d (item %d); mode %s, armed %s, WP known %s, cruise %s m/s -> %s",
                 sysid, n, seq, snap.mode if snap else None, snap.armed if snap else None,
                 target is not None, self._cruise_ms.get(sysid),
                 "stop-turn-fly" if needs_turn else "plain jump (no turn needed)")
        if not needs_turn:
            if not await self._set_current_ack(sysid, seq):
                return False, f"{label}: the FC refused mission item {seq}"
            if in_auto:
                return True, f"{label} (mission item {seq}){self._speed_note(sysid)}"
            return True, f"{label} (mission item {seq}) — takes effect when AUTO runs"

        # 1. GUIDED — brakes to a stop on entry.
        ack = await self.set_mode_ack(sysid, "GUIDED")
        log.info("[jump] sysid %d: GUIDED -> %s", sysid, ack.name)
        if not ack.ok:
            return False, f"{label}: GUIDED refused ({ack.name}) — still in AUTO, no change"
        if not await self._wait_mode(sysid, "GUIDED"):
            log.info("[jump] sysid %d: GUIDED acked but not entered", sysid)
            return False, f"{label}: GUIDED not entered — check the mode"

        # 2. Stop and face the waypoint.
        why = await self._stop_and_face(sysid, target[0], target[1], stop_reason)
        if why:
            log.info("[jump] sysid %d: stopped — %s", sysid, why)
            return False, f"{label} stopped: {why}"

        # 3. Make it the current item, then resume AUTO from it.
        if not await self._set_current_ack(sysid, seq):
            return False, f"{label}: the FC refused mission item {seq} — holding in GUIDED"
        why = stop_reason()
        if why:
            log.info("[jump] sysid %d: stopped before AUTO — %s", sysid, why)
            return False, f"{label} stopped: {why}"
        ack = await self.set_mode_ack(sysid, "AUTO")
        log.info("[jump] sysid %d: AUTO -> %s", sysid, ack.name)
        if not ack.ok:
            return False, f"{label}: AUTO refused ({ack.name}) — holding in GUIDED"
        if not await self._wait_mode(sysid, "AUTO"):
            log.info("[jump] sysid %d: AUTO acked but not entered — holding in GUIDED", sysid)
            return False, f"{label}: AUTO not entered — holding in GUIDED"
        log.info("[jump] sysid %d: done — back in AUTO, heading for WP %d", sysid, n)
        return True, f"{label}: turned to face it, back in AUTO{self._speed_note(sysid)}"
