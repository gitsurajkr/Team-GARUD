"""WebSocket fan-out hub.

Holds the set of connected GCS clients and broadcasts JSON frames. The MAVLink
thread never touches sockets directly — the app's asyncio broadcaster reads
registry snapshots and calls `broadcast()` on this event loop.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Awaitable, Callable, Optional, Set

import websockets
from websockets.legacy.server import WebSocketServerProtocol

log = logging.getLogger("airunit.ws")

# Called with each inbound command frame (parsed JSON dict) from a GCS client.
CommandHandler = Callable[[dict], Awaitable[None]]


class Hub:
    def __init__(self) -> None:
        self._clients: Set[WebSocketServerProtocol] = set()

    async def register(self, ws: WebSocketServerProtocol) -> None:
        self._clients.add(ws)
        log.info("client connected (%d total)", len(self._clients))

    async def unregister(self, ws: WebSocketServerProtocol) -> None:
        self._clients.discard(ws)
        log.info("client disconnected (%d total)", len(self._clients))

    @property
    def client_count(self) -> int:
        return len(self._clients)

    async def broadcast(self, payload: dict) -> None:
        if not self._clients:
            return
        msg = json.dumps(payload, separators=(",", ":"))
        dead = []
        for ws in list(self._clients):
            try:
                await ws.send(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._clients.discard(ws)


# asyncio keeps only a weak reference to a running task, so one nobody holds can
# be garbage-collected mid-flight. Park them here until they finish.
_inflight: set = set()


async def _run_command(on_command: CommandHandler, frame: dict) -> None:
    try:
        await on_command(frame)
    except Exception:
        log.exception("command handler failed: %s", frame.get("cmd"))


async def _handler(
    ws: WebSocketServerProtocol, hub: "Hub", on_command: Optional[CommandHandler]
) -> None:
    await hub.register(ws)
    try:
        async for raw in ws:
            if on_command is None:
                continue
            try:
                frame = json.loads(raw)
            except Exception:
                log.warning("dropping non-JSON inbound frame")
                continue
            if isinstance(frame, dict) and "cmd" in frame:
                # Dispatched, NOT awaited. Awaiting here would hold the read loop
                # for the whole command — a mission launch takes tens of seconds,
                # during which an emergency disarm could not even be parsed.
                # Ordering and mutual exclusion are handled per-drone inside
                # services.commands, not by stalling the socket.
                task = asyncio.create_task(_run_command(on_command, frame))
                _inflight.add(task)
                task.add_done_callback(_inflight.discard)
    except Exception:
        pass
    finally:
        await hub.unregister(ws)


async def serve(hub: Hub, host: str, port: int, on_command: Optional[CommandHandler] = None):
    """Start the WebSocket server; returns the server object (keep it alive)."""
    handler = lambda ws: _handler(ws, hub, on_command)
    server = await websockets.serve(handler, host, port, ping_interval=20)
    log.info("websocket server on ws://%s:%d", host, port)
    return server
