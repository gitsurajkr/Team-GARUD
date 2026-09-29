"""Command service — routes inbound WebSocket command frames to the FcRuntime.

Frame shape from the GCS:  {"cmd": "arm", "sysid": 1, ...extra fields}
Every command emits a `command_ack` back; some also emit richer frames
(`preflight_result`, `mission_progress`).
"""
from __future__ import annotations

import asyncio
import logging
from typing import Dict, List

from ..infrastructure.fc_runtime import FcRuntime
from ..models import CommandAck, MissionProgress
from ..transport.ws_server import Hub

log = logging.getLogger("airunit.cmd")


# asyncio holds only a weak reference to a running task, so a task nobody keeps
# can be garbage-collected mid-flight. Park them here until they finish.
_detached: set = set()


def _spawn_detached(coro) -> None:
    task = asyncio.create_task(coro)
    _detached.add(task)
    task.add_done_callback(_detached.discard)


async def _preflight_job(runtime: FcRuntime, hub: Hub, sysid: int) -> None:
    try:
        result = await runtime.preflight(sysid)
        await hub.broadcast(result.to_dict())
    except Exception:
        log.exception("preflight failed for sysid %s", sysid)


# One lock per drone. Long commands hold it so they cannot interleave on the
# same aircraft (overlapping mission uploads corrupt the MAVLink mission state
# machine, and concurrent param reads steal each other's PARAM_VALUEs). Short
# and emergency commands never take it, which is the whole point: an operator's
# disarm must not wait behind a 30-second launch sequence.
_sysid_locks: Dict[int, asyncio.Lock] = {}


def _lock_for(sysid: int) -> asyncio.Lock:
    lock = _sysid_locks.get(sysid)
    if lock is None:
        lock = asyncio.Lock()
        _sysid_locks[sysid] = lock
    return lock


async def _run_locked(sysid: int, label: str, coro, on_busy) -> None:
    """Run a long command under the drone's lock, or refuse if one is running.

    Refusing beats queueing: a mission upload that finally starts 30 s after the
    click is not what the operator asked for.
    """
    lock = _lock_for(sysid)
    if lock.locked():
        coro.close()  # never awaited — close it so Python does not warn
        await on_busy()
        return
    async with lock:
        try:
            await coro
        except Exception:
            log.exception("%s failed for sysid %s", label, sysid)


def _safety_blocks(runtime: FcRuntime, sysid: int) -> bool:
    """True when the safety switch must stop a motor-capable command.

    Fails CLOSED: anything other than a definite False blocks. The switch is the
    operator's latch, so "we don't know" means "not yet cleared to fly". Boards
    with no switch report a definite False via note_safety_unsupported(), so they
    are not caught by this.
    """
    return runtime.safety_engaged(sysid) is not False


def _opt_float(v) -> float | None:
    """Optional numeric field: absent, null or unparseable -> None (use the FC's
    own default) rather than a silent 0."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f > 0 else None


def roster_payload(runtime: FcRuntime) -> dict:
    """Roster frame: every drone seen on the wire + its connection status."""
    connected = runtime.connected_sysids()
    kinds = runtime.route_kinds()
    links = runtime.link_names()
    drones = []
    for s in runtime.registry.snapshots():
        drones.append({
            "sysid": s.sysid,
            "drone_id": s.drone_id,
            "connected": s.sysid in connected,
            "linked": s.connected,   # telemetry fresh (heartbeat within timeout)
            "armed": s.armed,
            "mode": s.mode,
            "real": kinds.get(s.sysid) == "serial",  # real drone via telemetry radio
            "link": links.get(s.sysid),              # "COM4" / "ip:port"
            "conflict": runtime.conflict(s.sysid),   # ports sharing this sysid
        })
    return {"type": "drones", "drones": drones}


def _conflict_detail(sid: int, ports: List[str]) -> str:
    return (
        f"SYSID {sid} is used by more than one aircraft ({' + '.join(ports)}). "
        "Give each a unique SYSID_THISMAV and reboot it."
    )


def _fanned(ports: List[str]) -> str:
    """Suffix for a disarm/kill ack that went to every aircraft on a clashing sysid."""
    return f" — to EVERY aircraft on this SYSID ({' + '.join(ports)})" if ports else ""


async def dispatch(frame: dict, runtime: FcRuntime, hub: Hub) -> None:
    cmd = frame.get("cmd")
    sysid = frame.get("sysid")

    async def ack(ok: bool, detail: str = "") -> None:
        await hub.broadcast(CommandAck(int(sysid) if sysid is not None else 0, str(cmd), ok, detail).to_dict())

    try:
        if cmd == "scan":
            await hub.broadcast(roster_payload(runtime))
            return

        if sysid is None:
            await ack(False, "missing sysid")
            return
        sid = int(sysid)

        async def push_roster() -> None:
            # Immediately, not on the next 1 Hz tick, so the button flips on click.
            await hub.broadcast(roster_payload(runtime))

        # Two aircraft on one sysid: nothing may be sent that targets "the"
        # aircraft, because there isn't one. Disconnect is local; disarm/kill
        # fan out to every radio carrying the sysid (FcRuntime._send_to).
        clash = runtime.conflict(sid)
        if clash and cmd not in ("disconnect", "disarm", "kill"):
            await ack(False, _conflict_detail(sid, clash))
            return

        if cmd == "connect":
            ok = runtime.connect(sid)
            await ack(ok, "connected — streams requested" if ok else "drone not seen yet — press Scan")
            await push_roster()
            return
        if cmd == "disconnect":
            # Cancel a launch sequence part-way through: it must not carry on
            # arming an aircraft this GCS no longer shows or controls.
            runtime.bump_abort(sid)
            runtime.disconnect(sid)
            await ack(True, "disconnected")
            await push_roster()
            return

        # Being heard on the wire is not permission to command. Only the
        # emergency lane (disarm / kill) bypasses this — it must never be the
        # thing that fails because of a stale connect state.
        if cmd not in ("disarm", "kill") and not runtime.is_connected(sid):
            await ack(False, f"SYS {sid} is not connected — press Connect first")
            return

        if cmd == "arm":
            # The safety switch physically inhibits motor output — arming past it
            # cannot work, so reject here with a reason the operator can act on
            # rather than firing a command the FC will silently refuse. Not even
            # FORCE ARM gets through: 21196 bypasses prearm checks in software,
            # never the hardware switch.
            if _safety_blocks(runtime, sid):
                await ack(False, "rejected — safety switch is ON. Turn it OFF first.")
            else:
                runtime.arm(sid, True)
                await ack(True, "arm sent")
        elif cmd == "force_arm":
            if _safety_blocks(runtime, sid):
                await ack(False, "rejected — safety switch is ON (force arm cannot bypass it).")
            else:
                runtime.force_arm(sid)
                await ack(True, "FORCE ARM sent — prearm/failsafe bypassed")
        elif cmd == "kill":
            # EMERGENCY LANE — the highest-priority command there is. Runs inline,
            # takes no lock, waits for nothing.
            #
            # Force disarm cuts motor output immediately and ends the mission,
            # because AUTO cannot run on a disarmed vehicle. In flight the
            # aircraft WILL fall; that is the point of a kill switch, and why the
            # GCS confirms before sending it. Unlike the safety switch this is
            # deliberately permitted while armed — it is the one control that is
            # supposed to work there.
            runtime.bump_abort(sid)
            runtime.force_disarm(sid)
            log.warning("sysid %d: KILL — force disarm issued by operator", sid)
            await ack(True, "KILL — force disarm sent, motors stopped" + _fanned(clash))
        elif cmd == "disarm":
            # EMERGENCY LANE: runs inline, immediately, and cancels any sequence
            # mid-flight — otherwise a launch already past its arm step would
            # re-arm a second later and the disarm would look ignored.
            runtime.bump_abort(sid)
            runtime.arm(sid, False)
            await ack(True, "disarm sent" + _fanned(clash))
        elif cmd == "takeoff":
            if _safety_blocks(runtime, sid):
                await ack(False, "rejected — safety switch is ON. Turn it OFF first.")
            else:
                alt = float(frame.get("alt", 10))
                runtime.takeoff(sid, alt)
                await ack(True, f"takeoff to {alt:g} m")
        elif cmd == "set_mode":
            mode = str(frame.get("mode", ""))
            ok = runtime.set_mode(sid, mode)
            await ack(ok, f"mode {mode}" if ok else f"unknown mode '{mode}'")
        elif cmd == "reposition":
            lat, lon = float(frame["lat"]), float(frame["lon"])
            alt = float(frame.get("alt", 10))

            # Stop -> turn -> fly takes seconds; detached so it cannot sit in
            # front of a disarm. Not locked: a newer click supersedes the turn
            # in progress (FcRuntime._new_maneuver) instead of being refused.
            async def _fly_job() -> None:
                try:
                    ok5, detail5 = await runtime.fly_to(sid, lat, lon, alt)
                except Exception as e:
                    log.exception("reposition failed for sysid %s", sid)
                    ok5, detail5 = False, f"reposition failed: {e}"
                await ack(ok5, detail5)

            _spawn_detached(_fly_job())
        elif cmd == "set_current":
            # `seq` is the operator's waypoint number, not a raw mission item.
            n = int(frame["seq"])
            resolved = runtime.waypoint_seq(sid, n)
            if resolved is None:
                total = runtime.waypoint_count(sid)
                await ack(False, (
                    f"no waypoint {n} — upload a mission first"
                    if total == 0 else
                    f"no waypoint {n} — this mission has {total}"
                ))
            else:
                async def _jump_job() -> None:
                    try:
                        ok6, detail6 = await runtime.jump_to(sid, n, resolved)
                    except Exception as e:
                        log.exception("jump failed for sysid %s", sid)
                        ok6, detail6 = False, f"jump failed: {e}"
                    await ack(ok6, detail6)

                _spawn_detached(_jump_job())
        elif cmd == "preflight":
            # Runs off the command loop: it takes ~2 s (the FC needs time to run
            # its prearm checks and emit the reasons), and ws_server awaits each
            # command inline — blocking here would delay an emergency disarm
            # queued behind it. The result is broadcast, not returned, so nothing
            # depends on it completing in order.
            _spawn_detached(_preflight_job(runtime, hub, sid))
        elif cmd == "set_fence":
            # Five sequential param writes — up to ~12 s. Detached so it cannot
            # sit in front of a disarm.
            async def _fence_job() -> None:
                ok2, detail2 = await runtime.set_fence(
                    sid,
                    radius_m=float(frame.get("radius", 300)),
                    alt_max_m=float(frame.get("alt_max", 60)),
                    action=int(frame.get("action", 1)),
                    enable=bool(frame.get("enable", True)),
                )
                await ack(ok2, detail2)
                # Broadcast what the FC actually stored, so the map circle
                # reflects the aircraft rather than what we asked for.
                await hub.broadcast(await runtime.get_fence(sid))

            _spawn_detached(_run_locked(
                sid, "set_fence", _fence_job(),
                lambda: ack(False, f"busy — another operation is running for SYS {sid}"),
            ))
        elif cmd == "get_fence":
            await hub.broadcast(await runtime.get_fence(sid))
        elif cmd == "set_safety":
            # Required, not defaulted: a malformed frame must never be read as
            # "release the switch".
            if "disengage" not in frame:
                await ack(False, "set_safety requires an explicit `disengage` field")
                return
            disengage = bool(frame["disengage"])
            if not disengage:
                # Engaging the switch inhibits motor output IN HARDWARE. On the
                # ground that is the safe state; in the air it is not a safety
                # action at all — it cuts the motors and the aircraft falls.
                # ArduPilot itself only honours the physical switch while
                # disarmed (BRD_SAFETYOPTION default), but the MAVLink command is
                # not guarded the same way in every build, so refuse it here.
                # Disarm is the emergency action while flying; it is instant and
                # it cancels a running sequence.
                snap = runtime.registry.snapshot(sid)
                if snap is not None and snap.armed:
                    await ack(False, (
                        "rejected — cannot engage the safety switch while armed. "
                        "It would cut the motors in flight. Use Disarm."
                    ))
                    return
                # EMERGENCY LANE (on the ground): inhibiting the motors also
                # cancels a launch that is part-way through.
                runtime.bump_abort(sid)
            a2 = await runtime.set_safety_switch(sid, dangerous=disengage)
            if a2.ok:
                await ack(True, f"safety switch {'OFF — motors live' if disengage else 'ON (safe)'}")
            elif a2.unsupported:
                await ack(False, "flight controller has no safety switch (UNSUPPORTED)")
            else:
                await ack(False, f"safety switch refused: {a2.name}")
            # No prearm re-run here. It used to exist to flush a stale
            # "PreArm: Safety Switch" line, but the inference now timestamps the
            # command and ignores complaints older than it — so the state is
            # already correct the moment this ack lands. Re-running would fire
            # RUN_PREARM_CHECKS at the aircraft on every toggle for nothing.
        elif cmd == "get_failsafe":
            await hub.broadcast(await runtime.get_failsafe(sid))
        elif cmd == "set_failsafe":
            # Up to six sequential param writes — same treatment as set_fence.
            async def _failsafe_job() -> None:
                ok3, detail3 = await runtime.set_failsafe(sid, frame.get("values") or {})
                await ack(ok3, detail3)
                await hub.broadcast(await runtime.get_failsafe(sid))

            _spawn_detached(_run_locked(
                sid, "set_failsafe", _failsafe_job(),
                lambda: ack(False, f"busy — another operation is running for SYS {sid}"),
            ))
        elif cmd == "set_speed":
            sp = _opt_float(frame.get("speed"))
            if sp is None:
                await ack(False, "speed must be > 0")
            else:
                a = await runtime.set_speed(sid, sp)
                await ack(a.ok, f"speed {sp:g} m/s: {a.name}")
        elif cmd == "upload_mission":
            wps: List[dict] = frame.get("waypoints", [])

            async def _progress(p: MissionProgress) -> None:
                await hub.broadcast(p.to_dict())

            # Unbounded: the mission protocol retries per item. Two overlapping
            # uploads to one aircraft corrupt its mission state machine, which is
            # why _run_locked refuses rather than queues.
            async def _upload_job() -> None:
                # takeoff_alt must be included here too, not just on the
                # start_mission path. ArduCopter refuses to enter AUTO from the
                # ground with "Auto: Missing Takeoff Cmd" when the mission has no
                # NAV_TAKEOFF — so an Upload without one produces a mission the
                # operator cannot fly by arming and selecting AUTO by hand.
                ok4 = await runtime.upload_mission(
                    sid, wps, _progress,
                    default_alt=float(frame.get("alt", 15)),
                    takeoff_alt=float(frame.get("takeoff_alt", 10)),
                    speed=_opt_float(frame.get("speed")),
                    finish=str(frame.get("finish", "rtl")),
                )
                await ack(ok4, "mission uploaded" if ok4 else "mission upload failed")

            _spawn_detached(_run_locked(
                sid, "upload_mission", _upload_job(),
                lambda: ack(False, f"busy — a mission operation is already running for SYS {sid}"),
            ))
        elif cmd == "start_mission":
            wps2: List[dict] = frame.get("waypoints", [])

            async def _progress2(p: MissionProgress) -> None:
                await hub.broadcast(p.to_dict())

            async def _start_job() -> None:
                ok, detail = await runtime.start_mission(
                    sid, wps2, _progress2,
                    cruise_alt=float(frame.get("alt", 15)),
                    takeoff_alt=float(frame.get("takeoff_alt", 10)),
                    speed=_opt_float(frame.get("speed")),
                    finish=str(frame.get("finish", "rtl")),
                )
                await ack(ok, detail)

            _spawn_detached(_run_locked(
                sid, "start_mission", _start_job(),
                lambda: ack(False, f"busy — a mission operation is already running for SYS {sid}"),
            ))
        else:
            await ack(False, f"unknown command '{cmd}'")
    except Exception as e:  # never let one bad frame kill the socket
        log.exception("command failed: %s", frame)
        await ack(False, str(e))
