"""air-unit — multi-drone SITL telemetry bridge for the GCS.

Mirrors the telemetry schema of the on-drone `Air-Unit` companion stack
(navigation / attitude / gps / battery), but reads all SITL drones off a single
MAVLink UDP port, demuxes them by system id, and fans the data out to the GCS
over a plain JSON WebSocket instead of NATS/ZMQ.
"""

__version__ = "0.1.0"
