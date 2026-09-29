"""MAVLink / ArduPilot enums — ported from Air-Unit (src/core/types/enums.py).

Kept copter-focused since the SITL swarm runs ArduCopter; PlaneMode is
included for completeness so mode decoding degrades gracefully.
"""
from __future__ import annotations

from enum import IntEnum, unique


@unique
class MavSeverity(IntEnum):
    EMERGENCY = 0
    ALERT = 1
    CRITICAL = 2
    ERROR = 3
    WARNING = 4
    NOTICE = 5
    INFO = 6
    DEBUG = 7


@unique
class CopterMode(IntEnum):
    STABILIZE = 0
    ACRO = 1
    ALT_HOLD = 2
    AUTO = 3
    GUIDED = 4
    LOITER = 5
    RTL = 6
    CIRCLE = 7
    LAND = 9
    DRIFT = 11
    SPORT = 13
    FLIP = 14
    AUTOTUNE = 15
    POSHOLD = 16
    BRAKE = 17
    THROW = 18
    AVOID_ADSB = 19
    GUIDED_NOGPS = 20
    SMART_RTL = 21
    FLOWHOLD = 22
    FOLLOW = 23
    ZIGZAG = 24
    SYSTEMID = 25
    AUTOROTATE = 26
    AUTO_RTL = 27


def mode_name(custom_mode: int) -> str:
    """ArduCopter custom_mode -> mode name, or UNKNOWN(n)."""
    if custom_mode in CopterMode._value2member_map_:
        return CopterMode(custom_mode).name
    return f"UNKNOWN({custom_mode})"


def mode_number(name: str) -> int | None:
    """Mode name (case-insensitive) -> ArduCopter custom_mode number."""
    try:
        return CopterMode[name.strip().upper()].value
    except KeyError:
        return None
