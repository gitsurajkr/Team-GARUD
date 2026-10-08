# Perception & indoor navigation

How the drone sees, localises and explores **without GPS**. This page describes
what the stack does and how it was tested. The algorithms themselves are our own
work and are **not published** here.

---

## The pipeline

```
 Livox Mid-360 ──▶  LiDAR-inertial SLAM  ──▶  position  ──▶  ArduPilot (external nav)
   3D LiDAR + IMU          │
                           ▼
                     live 3D map  ──▶  exploration planner  ──▶  next safe waypoint
                           │
                           └──────────▶  GCS (operator sees the map grow)
```

| Stage | What it does |
| --- | --- |
| **Sensing** | Livox Mid-360: 360° horizontal, −7° to +52° vertical, with a built-in IMU. A downward rangefinder and optical flow cover the area under the drone that the LiDAR cannot see. |
| **Localisation** | LiDAR-inertial SLAM gives the drone its position and heading indoors. It is sent to the flight controller as its position source, in place of GPS. |
| **Mapping** | A live 3D occupancy map: free space, walls and unexplored space, updated every scan. Walls, overhangs and a net ceiling are all in 3D, not a flat 2D slice. |
| **Exploration** | Finds the boundaries between explored and unexplored space, chooses which to visit next, plans a path with a safety margin from every wall, and returns home when nothing is left. |
| **Safety** | Hard and soft margins from walls, slowing before sharp turns, and a fallback to return or land if the position estimate degrades. |

---

## How it is tested

Every change goes through two levels of testing before it reaches the aircraft:

1. **Fast closed-loop harness.** The planner flies many randomly generated mazes
   with simulated LiDAR, flight dynamics and command latency. We track rooms
   reached, closest approach to walls, wall contacts and mission time, and
   check new versions on mazes that were never used for tuning, so the stack
   isn't tuned to a single layout.
2. **Full-stack test.** Gazebo + ArduPilot SITL + the same SLAM that runs on
   the aircraft: narrow corridors, rooms, a net ceiling, debris on the floor and
   survivors placed in the rooms.

The navigation code also runs on the drone's own companion computer (NVIDIA
Jetson Orin Nano), and its update rate has been measured there.

---

## Status

- ✅ GPS-denied localisation and autonomous exploration
- ✅ Live 3D map streamed to the GCS
- ✅ Survivor detection, tagged on the map
- ✅ Runs on the on-board computer (Jetson Orin Nano), under 1 s per planning cycle
- ✅ 100 % of rooms reached across our test mazes
- ✅ ~90 % fewer wall contacts with turn-aware speed control
- 🔁 Continuous tuning for speed and wall margin
