"""Composition root — wires the FC runtime to the WebSocket hub.

  infrastructure.fc_runtime  (owns MAVLink conn, recv thread, command senders)
    -> mavlink.aggregator.DroneRegistry  (per-sysid telemetry + STATUSTEXT)
    -> transport.ws_server.Hub           (fan-out + inbound commands)
    -> services.commands.dispatch        (command routing)
"""
from __future__ import annotations

import asyncio
import logging

from .config import Config
from .infrastructure.fc_runtime import FcRuntime
from .mavlink.aggregator import DroneRegistry
from .services import commands
from .transport import ws_server

log = logging.getLogger("airunit.app")


async def _telemetry_loop(runtime: FcRuntime, hub: ws_server.Hub, rate_hz: float) -> None:
    period = 1.0 / max(rate_hz, 0.1)
    while True:
        # Only drones the operator has Connected. Everything heard on the wire
        # still shows in the roster, but a drone nobody connected must not drive
        # the HUD, the map or the command dock.
        connected = runtime.connected_sysids()
        snaps = [s for s in runtime.registry.snapshots() if s.sysid in connected]
        if snaps:
            await hub.broadcast({"type": "telemetry", "drones": [s.to_dict() for s in snaps]})
        await asyncio.sleep(period)


async def _roster_loop(
    runtime: FcRuntime, hub: ws_server.Hub, rate_hz: float, evict_sec: float
) -> None:
    period = 1.0 / max(rate_hz, 0.1)
    while True:
        # forget drones that have gone silent, so ghosts from prior SITL runs
        # (or drones you stopped) drop off the roster on their own.
        for sysid in runtime.registry.prune(evict_sec):
            runtime.forget(sysid)
            log.info("evicted silent drone sysid %d", sysid)
        await hub.broadcast(commands.roster_payload(runtime))
        await asyncio.sleep(period)


async def _status_loop(runtime: FcRuntime, hub: ws_server.Hub) -> None:
    """Push new ArduPilot STATUSTEXT lines as they arrive (~20 Hz drain)."""
    while True:
        connected = runtime.connected_sysids()
        for ev in runtime.registry.drain_status():
            # Drained either way, so a later Connect does not dump a backlog.
            if ev.sysid in connected:
                await hub.broadcast({"type": "status", **ev.to_dict()})
        await asyncio.sleep(0.05)


async def run(config: Config | None = None) -> None:
    cfg = config or Config.load()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)-16s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )
    log.info("air-unit starting")
    log.info("  mavlink : %s", cfg.connection)
    log.info("  ws      : ws://%s:%d", cfg.ws_host, cfg.ws_port)

    registry = DroneRegistry(cfg.timeout_sec)
    hub = ws_server.Hub()
    runtime = FcRuntime(cfg.connection, registry)
    runtime.bind_loop(asyncio.get_running_loop())
    runtime.start()

    async def on_command(frame: dict) -> None:
        await commands.dispatch(frame, runtime, hub)

    server = await ws_server.serve(hub, cfg.ws_host, cfg.ws_port, on_command)

    try:
        await asyncio.gather(
            _telemetry_loop(runtime, hub, cfg.telemetry_rate_hz),
            _roster_loop(runtime, hub, cfg.roster_rate_hz, cfg.evict_sec),
            _status_loop(runtime, hub),
        )
    finally:
        runtime.stop()
        server.close()
        await server.wait_closed()


def main() -> None:
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        log.info("shutting down")


if __name__ == "__main__":
    main()
