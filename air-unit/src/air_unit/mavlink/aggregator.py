"""Per-drone MAVLink message folding → Telemetry snapshots.

A `DroneRegistry` holds one `DroneState` per observed system id. Each incoming
MAVLink message updates the matching drone's latest values; `snapshot()`
projects those into the Air-Unit-shaped `Telemetry` model.
"""
from __future__ import annotations

import threading
import time
from typing import Dict, List, Optional

from pymavlink import mavutil

from ..core.enums import MavSeverity, mode_name
from ..models import (
    Attitude, Battery, Gps, Health, Home, Navigation, StatusEvent, Telemetry,
)

# MAV_RESULT codes that mean the command was accepted / still running.
_ACK_OK = (0, 5)  # MAV_RESULT_ACCEPTED, MAV_RESULT_IN_PROGRESS

# base_mode bit that indicates the vehicle is armed.
_MAV_MODE_FLAG_SAFETY_ARMED = 128

_mav = mavutil.mavlink

# SYS_STATUS sensor bits worth naming when they go unhealthy. The FC reports
# health for far more than this; these are the ones that ground a flight.
_SENSOR_BITS: List[tuple] = [
    (_mav.MAV_SYS_STATUS_SENSOR_3D_GYRO, "gyro"),
    (_mav.MAV_SYS_STATUS_SENSOR_3D_ACCEL, "accel"),
    (_mav.MAV_SYS_STATUS_SENSOR_3D_MAG, "compass"),
    (_mav.MAV_SYS_STATUS_SENSOR_ABSOLUTE_PRESSURE, "baro"),
    (_mav.MAV_SYS_STATUS_SENSOR_GPS, "gps"),
    (_mav.MAV_SYS_STATUS_SENSOR_RC_RECEIVER, "rc"),
    (_mav.MAV_SYS_STATUS_SENSOR_BATTERY, "battery"),
    (_mav.MAV_SYS_STATUS_AHRS, "ahrs"),
    (_mav.MAV_SYS_STATUS_GEOFENCE, "geofence"),
    (_mav.MAV_SYS_STATUS_LOGGING, "logging"),
    (_mav.MAV_SYS_STATUS_SENSOR_PROPULSION, "propulsion"),
]

# HEARTBEAT.system_status values that mean a failsafe has actually fired.
_MAV_STATE = {
    0: "UNINIT", 1: "BOOT", 2: "CALIBRATING", 3: "STANDBY", 4: "ACTIVE",
    5: "CRITICAL", 6: "EMERGENCY", 7: "POWEROFF", 8: "FLIGHT_TERMINATION",
}

# How long a "PreArm: ..." line stays interesting. ArduPilot re-emits them
# roughly every 30 s while the condition holds, so a short window keeps the
# preflight report showing only what is blocking arming *now*.
PREARM_TTL_SEC = 45.0

# A real flight controller changes armed state a handful of times per flight.
# This many flips inside the window means two vehicles are answering to one
# system id (e.g. two SITL instances on the same sysid) — not a real aircraft.
ARM_FLAP_FLIPS = 4
ARM_FLAP_WINDOW_SEC = 6.0


class DroneState:
    """Latest folded state for a single system id. Not thread-safe on its own;
    guard access with the registry lock."""

    def __init__(self, sysid: int, timeout_sec: float) -> None:
        self.sysid = sysid
        self.drone_id = f"drone-{sysid}"
        self._timeout = timeout_sec
        self.last_seen = 0.0

        self.armed = False
        self.mode = "UNKNOWN"
        # Component id of this system's autopilot, learned from its first
        # heartbeat. Only that component's heartbeats set armed / mode.
        self.autopilot_comp: Optional[int] = None
        self._arm_flips: List[float] = []   # times armed changed, for flap detection
        self._flap_warned_at = 0.0
        self.nav = Navigation()
        self.att = Attitude()
        self.gps = Gps()
        self.batt = Battery()
        # New STATUSTEXT lines awaiting broadcast to the GCS (drained each tick).
        self.new_status: List[StatusEvent] = []

        # --- flight-controller self-assessment (SYS_STATUS / HEARTBEAT) ------
        self.sensors_enabled = 0
        self.sensors_health = 0
        self.system_status = 0       # MAV_STATE; 5/6 mean a failsafe has fired
        self.have_sys_status = False
        # "PreArm: ..." / "Arm: ..." lines with the time they arrived, so the
        # preflight report can quote the FC's own blocking reasons.
        self.prearm: List[tuple] = []  # (timestamp, text)
        self.home = Home()
        # What we last commanded the safety switch to, once the FC acked it.
        # True = engaged (safe). None = never commanded it.
        self.safety_cmd: Optional[bool] = None
        # When that command was acked — prearm complaints older than this are
        # describing the switch's previous position and must not override it.
        self.safety_cmd_at: float = 0.0
        # False once the FC answers UNSUPPORTED — no safety switch is fitted, so
        # it can never be what is blocking the motors. None = not yet known.
        self.safety_supported: Optional[bool] = None

    def update(self, msg, now: float) -> None:
        self.last_seen = now
        mtype = msg.get_type()

        if mtype == "HEARTBEAT":
            # Every MAVLink component heartbeats — a companion computer, camera,
            # gimbal or OSD on the same sysid too, all with base_mode 0 ("not
            # armed") and custom_mode 0. Folding those in made the GCS flicker
            # ARMED / DISARMED once the FC was armed. Only the autopilot counts:
            # the others declare MAV_AUTOPILOT_INVALID, and after the first
            # autopilot heartbeat we stick to that component.
            if int(getattr(msg, "autopilot", _mav.MAV_AUTOPILOT_INVALID)) == _mav.MAV_AUTOPILOT_INVALID:
                return
            comp = msg.get_srcComponent()
            if self.autopilot_comp is None:
                self.autopilot_comp = comp
            elif comp != self.autopilot_comp:
                return
            armed = bool(msg.base_mode & _MAV_MODE_FLAG_SAFETY_ARMED)
            if armed != self.armed:
                self._note_arm_flip(now)
            self.armed = armed
            self.mode = mode_name(msg.custom_mode)
            self.system_status = int(getattr(msg, "system_status", 0))

        elif mtype == "STATUSTEXT":
            text = msg.text
            if isinstance(text, bytes):
                text = text.decode("utf-8", errors="ignore")
            sev = int(getattr(msg, "severity", 6))
            label = (
                MavSeverity(sev).name
                if sev in MavSeverity._value2member_map_
                else "UNKNOWN"
            )
            text = text.strip()
            self.new_status.append(
                StatusEvent(self.sysid, now, sev, label, text)
            )
            # ArduPilot reports what is blocking arming only as free text.
            # Keep the recent ones so preflight can quote them.
            low = text.lower()
            if low.startswith("prearm:") or low.startswith("arm:"):
                self.prearm.append((now, text))
                cutoff = now - PREARM_TTL_SEC
                self.prearm = [(t, s) for (t, s) in self.prearm if t >= cutoff][-12:]

        elif mtype == "COMMAND_ACK":
            # ArduPilot's accept/reject verdict for a command (arm, takeoff, …).
            cmd_enum = mavutil.mavlink.enums.get("MAV_CMD", {})
            res_enum = mavutil.mavlink.enums.get("MAV_RESULT", {})
            cmd_name = cmd_enum[msg.command].name if msg.command in cmd_enum else f"CMD {msg.command}"
            res = int(msg.result)
            res_name = res_enum[res].name if res in res_enum else f"result {res}"
            cmd_short = cmd_name.replace("MAV_CMD_", "")
            res_short = res_name.replace("MAV_RESULT_", "")
            ok = res in _ACK_OK
            self.new_status.append(
                StatusEvent(
                    self.sysid, now,
                    MavSeverity.INFO if ok else MavSeverity.ERROR,
                    "ACK" if ok else "REJECT",
                    f"{cmd_short}: {res_short}",
                )
            )

        elif mtype == "GLOBAL_POSITION_INT":
            self.nav.latitude = msg.lat / 1e7
            self.nav.longitude = msg.lon / 1e7
            self.nav.altitude = msg.relative_alt / 1000.0
            self.nav.altitude_amsl = msg.alt / 1000.0
            self.nav.heading = (msg.hdg / 100.0) if msg.hdg != 65535 else self.nav.heading

        elif mtype == "HOME_POSITION":
            # The FC's real home — what RTL returns to and what the geofence is
            # centred on. Not the same as wherever we first saw the drone.
            self.home = Home(
                latitude=msg.latitude / 1e7,
                longitude=msg.longitude / 1e7,
                altitude=msg.altitude / 1000.0,
            )

        elif mtype == "GPS_RAW_INT":
            self.gps.fixtype = msg.fix_type
            self.gps.satellites = msg.satellites_visible
            self.gps.hdop = (msg.eph / 100.0) if msg.eph != 65535 else None

        elif mtype == "VFR_HUD":
            self.nav.groundspeed = msg.groundspeed
            self.nav.airspeed = msg.airspeed
            self.nav.climbrate = msg.climb
            if self.nav.heading is None:
                self.nav.heading = float(msg.heading)

        elif mtype == "ATTITUDE":
            self.att.roll = msg.roll
            self.att.pitch = msg.pitch
            # store yaw in degrees, wrapped to -180..180 (Air-Unit convention)
            import math
            self.att.yaw = math.degrees(msg.yaw)

        elif mtype == "SYS_STATUS":
            self.batt.voltage = (msg.voltage_battery / 1000.0) if msg.voltage_battery != 65535 else None
            self.batt.current = (msg.current_battery / 100.0) if msg.current_battery != -1 else None
            self.batt.level = msg.battery_remaining if msg.battery_remaining != -1 else None
            # The FC's own verdict on itself — including the prearm bit, which is
            # the only authoritative "would this arm right now?" we ever get.
            self.sensors_enabled = int(msg.onboard_control_sensors_enabled)
            self.sensors_health = int(msg.onboard_control_sensors_health)
            self.have_sys_status = True

        elif mtype == "BATTERY_STATUS":
            if msg.voltages and msg.voltages[0] != 65535:
                self.batt.voltage = msg.voltages[0] / 1000.0
            if msg.current_battery != -1:
                self.batt.current = msg.current_battery / 100.0
            if msg.current_consumed != -1:
                self.batt.consumed_mah = msg.current_consumed
            if msg.battery_remaining != -1:
                self.batt.level = msg.battery_remaining

    def _note_arm_flip(self, now: float) -> None:
        """Warn the operator when armed state flaps faster than any aircraft can.

        That means two vehicles are heartbeating on this sysid with the same
        autopilot component — one armed, one not — and every telemetry field is
        a mix of both. Over serial this is caught as a SYSID conflict; over UDP
        (SITL) the same drone can legitimately arrive from two addresses, so the
        heartbeat content is the only reliable tell.
        """
        self._arm_flips = [t for t in self._arm_flips if now - t < ARM_FLAP_WINDOW_SEC]
        self._arm_flips.append(now)
        if len(self._arm_flips) >= ARM_FLAP_FLIPS and now - self._flap_warned_at > 30.0:
            self._flap_warned_at = now
            self.new_status.append(StatusEvent(
                self.sysid, now, MavSeverity.CRITICAL, "CRITICAL",
                f"SYS {self.sysid}: armed state is flapping — two vehicles are "
                "using this system id. Telemetry and commands are mixed between "
                "them. Give each a unique SYSID_THISMAV (SITL: --auto-sysid).",
            ))

    @property
    def connected(self) -> bool:
        return (time.time() - self.last_seen) <= self._timeout

    def health_view(self) -> Health:
        """Project the FC's self-assessment into the wire model.

        A sensor only counts as unhealthy when it is *enabled* — the FC reports
        health bits for hardware that isn't fitted, and those read as 0.
        `prearm_ok` is None until a SYS_STATUS has actually arrived, so the UI
        can say "unknown" rather than falsely claiming failure.
        """
        unhealthy: List[str] = []
        prearm_ok = None
        if self.have_sys_status:
            for bit, name in _SENSOR_BITS:
                if (self.sensors_enabled & bit) and not (self.sensors_health & bit):
                    unhealthy.append(name)
            bit = _mav.MAV_SYS_STATUS_PREARM_CHECK
            prearm_ok = bool(self.sensors_health & bit) if (self.sensors_enabled & bit) else None

        # MAVLink carries no safety-switch field, so work it out, newest evidence
        # first. Two time rules matter:
        #
        #  * the TTL — `self.prearm` is only pruned when a NEW prearm line
        #    arrives, and after a disengage the FC usually stops complaining, so
        #    without a cutoff one stale line would pin the state forever;
        #  * `safety_cmd_at` — a prearm line emitted BEFORE we moved the switch
        #    is describing where it used to be, so it must not outrank the
        #    command that moved it. Only complaints newer than our command count.
        cutoff = max(time.time() - PREARM_TTL_SEC, self.safety_cmd_at)
        blocking = any(
            "safety switch" in s.lower() for (t, s) in self.prearm if t >= cutoff
        )
        if self.safety_supported is False:
            # The FC answered UNSUPPORTED: there is no switch to inhibit anything.
            safety_engaged = False
        elif blocking:
            safety_engaged = True
        elif self.safety_cmd is not None:
            safety_engaged = self.safety_cmd
        elif prearm_ok is True:
            safety_engaged = False
        else:
            safety_engaged = None

        return Health(
            safety_engaged=safety_engaged,
            prearm_ok=prearm_ok,
            unhealthy=unhealthy,
            system_status=_MAV_STATE.get(self.system_status, str(self.system_status)),
            failsafe=self.system_status in (5, 6),
            prearm_messages=[s for (t, s) in self.prearm if t >= cutoff],
        )

    def snapshot(self) -> Telemetry:
        return Telemetry(
            sysid=self.sysid,
            drone_id=self.drone_id,
            timestamp=self.last_seen,
            connected=self.connected,
            armed=self.armed,
            mode=self.mode,
            navigation=Navigation(**vars(self.nav)),
            attitude=Attitude(**vars(self.att)),
            gps=Gps(**vars(self.gps)),
            battery=Battery(**vars(self.batt)),
            health=self.health_view(),
            home=Home(**vars(self.home)),
        )


class DroneRegistry:
    """Thread-safe registry of drones keyed by system id."""

    def __init__(self, timeout_sec: float) -> None:
        self._timeout = timeout_sec
        self._drones: Dict[int, DroneState] = {}
        # sysid -> (safety_cmd, safety_cmd_at, safety_supported). Survives prune.
        self._safety: Dict[int, tuple] = {}
        self._lock = threading.Lock()

    def ingest(self, msg) -> int | None:
        """Fold a MAVLink message into its drone. Returns the sysid, or None
        for messages without a usable source system (e.g. sysid 0 / GCS)."""
        sysid = msg.get_srcSystem()
        if sysid is None or sysid == 0 or sysid == 255:
            return None
        mtype = msg.get_type()
        if mtype == "BAD_DATA":
            return None
        now = time.time()
        with self._lock:
            drone = self._drones.get(sysid)
            if drone is None:
                drone = DroneState(sysid, self._timeout)
                # The safety latch outlives the telemetry state on purpose: a
                # drone silent past evict_sec is dropped and rebuilt, and
                # forgetting where the operator left the switch would silently
                # flip the GCS back to "ON (assumed)" after a link hiccup.
                held = self._safety.get(sysid)
                if held is not None:
                    drone.safety_cmd, drone.safety_cmd_at, drone.safety_supported = held
                self._drones[sysid] = drone
            drone.update(msg, now)
        return sysid

    def snapshots(self) -> List[Telemetry]:
        with self._lock:
            return [d.snapshot() for d in sorted(self._drones.values(), key=lambda x: x.sysid)]

    def snapshot(self, sysid: int) -> Telemetry | None:
        with self._lock:
            d = self._drones.get(sysid)
            return d.snapshot() if d else None

    def note_safety(self, sysid: int, engaged: bool) -> None:
        """Record a safety-switch command the FC has acked. MAVLink gives no
        readback, so this is the closest thing to knowing where the switch is."""
        with self._lock:
            d = self._drones.get(sysid)
            now = time.time()
            self._safety[sysid] = (engaged, now, True)
            if d is not None:
                d.safety_cmd = engaged
                d.safety_cmd_at = now
                d.safety_supported = True

    def note_safety_unsupported(self, sysid: int) -> None:
        """The FC has no safety switch (it answered UNSUPPORTED). Without this,
        such a board reads as "unknown" forever and the fail-safe default grounds
        an aircraft that has no switch to release."""
        with self._lock:
            d = self._drones.get(sysid)
            prev = self._safety.get(sysid, (None, 0.0, None))
            self._safety[sysid] = (prev[0], prev[1], False)
            if d is not None:
                d.safety_supported = False

    def sysids(self) -> List[int]:
        with self._lock:
            return sorted(self._drones.keys())

    def prune(self, max_age_sec: float) -> List[int]:
        """Forget drones silent for longer than max_age_sec. Returns their
        sysids so the runtime can drop them from its connected/address maps."""
        now = time.time()
        removed: List[int] = []
        with self._lock:
            for sysid in list(self._drones.keys()):
                if now - self._drones[sysid].last_seen > max_age_sec:
                    del self._drones[sysid]
                    removed.append(sysid)
        return removed

    def drain_status(self) -> List[StatusEvent]:
        """Collect and clear all drones' pending STATUSTEXT events."""
        out: List[StatusEvent] = []
        with self._lock:
            for d in self._drones.values():
                if d.new_status:
                    out.extend(d.new_status)
                    d.new_status = []
        return out
