/**
 * The subset of MAVLink message ids, CRC_EXTRA seeds, and enum constants this
 * GCS understands. Values are from the `common` and `minimal` MAVLink dialects.
 * CRC_EXTRA is the per-message seed used to finalise the frame CRC.
 */

export const MSG = {
  HEARTBEAT: 0,
  SYS_STATUS: 1,
  ATTITUDE: 30,
  LOCAL_POSITION_NED: 32,
  COMMAND_LONG: 76,
  STATUSTEXT: 253,
} as const;

/** CRC_EXTRA seeds keyed by msgid. */
export const CRC_EXTRA: Record<number, number> = {
  [MSG.HEARTBEAT]: 50,
  [MSG.SYS_STATUS]: 124,
  [MSG.ATTITUDE]: 39,
  [MSG.LOCAL_POSITION_NED]: 185,
  [MSG.COMMAND_LONG]: 152,
  [MSG.STATUSTEXT]: 83,
};

/** MAV_MODE_FLAG bits. */
export const MAV_MODE_FLAG = {
  CUSTOM_MODE_ENABLED: 0x01,
  SAFETY_ARMED: 0x80,
} as const;

/** MAV_CMD command ids we send. */
export const MAV_CMD = {
  NAV_RETURN_TO_LAUNCH: 20,
  DO_SET_MODE: 176,
  MISSION_START: 300,
  COMPONENT_ARM_DISARM: 400,
  DO_FLIGHTTERMINATION: 185,
} as const;

/**
 * ArduCopter custom flight-mode numbers (used with CUSTOM_MODE_ENABLED). These
 * are the modes relevant to an autonomous indoor mission and its aborts.
 */
export const COPTER_MODE = {
  STABILIZE: 0,
  GUIDED: 4,
  LOITER: 5,
  RTL: 6,
  AUTO: 3,
  BRAKE: 17,
  LAND: 9,
} as const;

/** Reverse lookup for display. */
export const COPTER_MODE_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(COPTER_MODE).map(([k, v]) => [v, k]),
);

/** Force-disarm magic value for COMPONENT_ARM_DISARM param2. */
export const ARM_FORCE_MAGIC = 21196;
