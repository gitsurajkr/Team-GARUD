"""MAVLink receive loop — runs in a background thread (pymavlink is blocking).

A single UDP connection receives every SITL drone forwarded to this port; each
frame carries its source system id, which `DroneRegistry.ingest` uses to demux.
"""
from __future__ import annotations

import logging
import threading

from pymavlink import mavutil

from .aggregator import DroneRegistry

log = logging.getLogger("airunit.mavlink")


class MavlinkListener(threading.Thread):
    def __init__(self, connection: str, registry: DroneRegistry) -> None:
        super().__init__(name="mavlink-listener", daemon=True)
        self._connection = connection
        self._registry = registry
        self._stop = threading.Event()
        self._conn = None

    def run(self) -> None:
        log.info("connecting to %s", self._connection)
        # source_system=254 marks us as a passive ground listener, not a vehicle.
        self._conn = mavutil.mavlink_connection(self._connection, source_system=254)
        log.info("listening for drones")
        while not self._stop.is_set():
            try:
                msg = self._conn.recv_match(blocking=True, timeout=1.0)
                if msg is None:
                    continue
                self._registry.ingest(msg)
            except Exception:  # keep the loop alive through transient decode errors
                log.exception("recv error")
        try:
            if self._conn:
                self._conn.close()
        except Exception:
            pass
        log.info("listener stopped")

    def stop(self) -> None:
        self._stop.set()
