"""Wire models mirroring the Air-Unit telemetry schema.

Plain dataclasses (no pydantic dependency). `None` means "not yet measured /
unavailable" — never a stand-in default, matching Air-Unit's null semantics.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Optional


@dataclass
class Navigation:
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    altitude: Optional[float] = None        # relative to home (m)
    altitude_amsl: Optional[float] = None   # MSL (m)
    groundspeed: Optional[float] = None     # m/s
    airspeed: Optional[float] = None        # m/s
    climbrate: Optional[float] = None       # m/s
    heading: Optional[float] = None         # deg 0..359


@dataclass
class Attitude:
    roll: Optional[float] = None            # rad
    pitch: Optional[float] = None           # rad
    yaw: Optional[float] = None             # deg -180..180


@dataclass
class Gps:
    fixtype: Optional[int] = None           # 0..6
    satellites: Optional[int] = None
    hdop: Optional[float] = None


@dataclass
class Battery:
    voltage: Optional[float] = None         # V
    current: Optional[float] = None         # A
    level: Optional[int] = None             # 0..100
    consumed_mah: Optional[int] = None


@dataclass
class Home:
    """The flight controller's own home position (HOME_POSITION), which is what
    RTL returns to and what the cylindrical geofence is centred on. Set at arming,
    and re-settable in flight — so never assume it is where the drone booted."""
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    altitude: Optional[float] = None        # AMSL (m)


@dataclass
class Health:
    """The flight controller's assessment of itself (SYS_STATUS / HEARTBEAT).

    This is the FC's own verdict, not ours — the only authority on whether the
    aircraft would actually arm.
    """
    # True/False from the FC's prearm bit; None = it hasn't told us yet.
    prearm_ok: Optional[bool] = None
    unhealthy: list = field(default_factory=list)   # enabled-but-unhealthy sensors
    system_status: str = "UNINIT"                   # MAV_STATE name
    failsafe: bool = False                          # system_status CRITICAL/EMERGENCY
    prearm_messages: list = field(default_factory=list)  # recent "PreArm: ..." text
    # Safety switch. MAVLink has NO field reporting this, so it is inferred:
    # True  = the FC is naming the safety switch as a prearm blocker,
    # False = prearm passes, so the switch cannot be inhibiting the motors,
    # None  = not enough evidence either way.
    safety_engaged: Optional[bool] = None


@dataclass
class Telemetry:
    """One drone's full state as sent to the GCS."""
    sysid: int = 0
    drone_id: str = ""
    timestamp: float = 0.0
    connected: bool = False
    armed: bool = False
    mode: str = "UNKNOWN"
    navigation: Navigation = field(default_factory=Navigation)
    attitude: Attitude = field(default_factory=Attitude)
    gps: Gps = field(default_factory=Gps)
    battery: Battery = field(default_factory=Battery)
    health: Health = field(default_factory=Health)
    home: Home = field(default_factory=Home)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class StatusEvent:
    """An ArduPilot STATUSTEXT line surfaced to the GCS console."""
    sysid: int
    timestamp: float
    severity: int          # 0..7 (MavSeverity)
    severity_label: str
    text: str

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class CommandAck:
    """Result of a GCS-issued command."""
    sysid: int
    command: str           # e.g. "arm", "takeoff"
    ok: bool
    detail: str = ""

    def to_dict(self) -> dict:
        return {"type": "command_ack", **asdict(self)}


@dataclass
class MissionProgress:
    sysid: int
    state: str             # "uploading" | "complete" | "failed"
    uploaded: int = 0
    total: int = 0
    detail: str = ""

    def to_dict(self) -> dict:
        return {"type": "mission_progress", **asdict(self)}


@dataclass
class PreflightCheck:
    name: str
    ok: bool
    detail: str


@dataclass
class PreflightResult:
    sysid: int
    ok: bool
    checks: list

    def to_dict(self) -> dict:
        return {
            "type": "preflight_result",
            "sysid": self.sysid,
            "ok": self.ok,
            "checks": [asdict(c) for c in self.checks],
        }
