"""Runtime configuration — loaded from config.yaml with env-var overrides."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import yaml

_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_CONFIG_PATH = _ROOT / "config.yaml"


@dataclass(frozen=True)
class Config:
    connection: str = "udpin:0.0.0.0:14550"
    timeout_sec: float = 3.0
    # Drop a drone from the roster entirely after this many seconds of silence
    # (so ghosts from previous SITL runs disappear on their own).
    evict_sec: float = 15.0
    ws_host: str = "127.0.0.1"
    ws_port: int = 8765
    telemetry_rate_hz: float = 10.0
    roster_rate_hz: float = 1.0

    @classmethod
    def load(cls, path: str | os.PathLike[str] | None = None) -> "Config":
        cfg_path = Path(path) if path else _DEFAULT_CONFIG_PATH
        data: dict = {}
        if cfg_path.exists():
            data = yaml.safe_load(cfg_path.read_text()) or {}

        mav = data.get("mavlink", {})
        ws = data.get("websocket", {})

        # Env overrides win over the file — handy for quick one-off runs.
        return cls(
            connection=os.environ.get("AIRUNIT_CONNECTION", mav.get("connection", cls.connection)),
            timeout_sec=float(mav.get("timeout_sec", cls.timeout_sec)),
            evict_sec=float(mav.get("evict_sec", cls.evict_sec)),
            ws_host=os.environ.get("AIRUNIT_WS_HOST", ws.get("host", cls.ws_host)),
            ws_port=int(os.environ.get("AIRUNIT_WS_PORT", ws.get("port", cls.ws_port))),
            telemetry_rate_hz=float(data.get("telemetry_rate_hz", cls.telemetry_rate_hz)),
            roster_rate_hz=float(data.get("roster_rate_hz", cls.roster_rate_hz)),
        )
