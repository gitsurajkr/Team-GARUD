/**
 * Minimal, dependency-free MAVLink v1/v2 frame codec.
 *
 * We deliberately hand-roll the wire format instead of pulling a native/parser
 * dependency so the default UDP link builds and runs with only Node built-ins.
 * This module handles framing + CRC only; message field decode lives in
 * `parser.ts` and message construction in `commands.ts`.
 *
 * Reference: https://mavlink.io/en/guide/serialization.html
 */

export const MAVLINK_STX_V1 = 0xfe;
export const MAVLINK_STX_V2 = 0xfd;
const V1_HEADER_LEN = 6; // stx,len,seq,sysid,compid,msgid
const V2_HEADER_LEN = 10; // stx,len,incompat,compat,seq,sysid,compid,msgid(3)
const V2_INCOMPAT_SIGNED = 0x01;
const V2_SIGNATURE_LEN = 13;

export interface MavFrame {
  version: 1 | 2;
  msgid: number;
  seq: number;
  sysid: number;
  compid: number;
  /** Raw (zero-truncated for v2) message payload. */
  payload: Buffer;
}

/**
 * Streaming frame splitter. Feed it arbitrary byte chunks from the transport;
 * it emits complete, structurally-valid frames. CRC is validated when a
 * CRC_EXTRA seed is known for the msgid (see `CRC_EXTRA`), otherwise the frame
 * is passed through unvalidated (logged upstream).
 */
export class MavlinkSplitter {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): MavFrame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: MavFrame[] = [];

    while (this.buf.length > 0) {
      const stx = this.buf[0];
      if (stx !== MAVLINK_STX_V1 && stx !== MAVLINK_STX_V2) {
        // Resync: drop until the next candidate start-of-frame byte.
        const next = this.indexOfStx(1);
        if (next === -1) {
          this.buf = Buffer.alloc(0);
          break;
        }
        this.buf = this.buf.subarray(next);
        continue;
      }

      const frame = stx === MAVLINK_STX_V2 ? this.tryV2() : this.tryV1();
      if (frame === "incomplete") break;
      if (frame === "bad") {
        // Corrupt frame: skip the STX and resync.
        this.buf = this.buf.subarray(1);
        continue;
      }
      out.push(frame.frame);
      this.buf = this.buf.subarray(frame.consumed);
    }
    return out;
  }

  private indexOfStx(from: number): number {
    for (let i = from; i < this.buf.length; i++) {
      if (this.buf[i] === MAVLINK_STX_V1 || this.buf[i] === MAVLINK_STX_V2) {
        return i;
      }
    }
    return -1;
  }

  private tryV1(): FrameResult {
    if (this.buf.length < V1_HEADER_LEN) return "incomplete";
    const len = this.buf[1];
    const total = V1_HEADER_LEN + len + 2; // + CRC
    if (this.buf.length < total) return "incomplete";
    const payload = this.buf.subarray(V1_HEADER_LEN, V1_HEADER_LEN + len);
    return {
      consumed: total,
      frame: {
        version: 1,
        seq: this.buf[2],
        sysid: this.buf[3],
        compid: this.buf[4],
        msgid: this.buf[5],
        payload: Buffer.from(payload),
      },
    };
  }

  private tryV2(): FrameResult {
    if (this.buf.length < V2_HEADER_LEN) return "incomplete";
    const len = this.buf[1];
    const incompat = this.buf[2];
    const signed = (incompat & V2_INCOMPAT_SIGNED) !== 0;
    const total =
      V2_HEADER_LEN + len + 2 + (signed ? V2_SIGNATURE_LEN : 0);
    if (this.buf.length < total) return "incomplete";
    const msgid =
      this.buf[7] | (this.buf[8] << 8) | (this.buf[9] << 16);
    const payload = this.buf.subarray(V2_HEADER_LEN, V2_HEADER_LEN + len);
    return {
      consumed: total,
      frame: {
        version: 2,
        seq: this.buf[4],
        sysid: this.buf[5],
        compid: this.buf[6],
        msgid,
        payload: Buffer.from(payload),
      },
    };
  }
}

type FrameResult = "incomplete" | "bad" | { consumed: number; frame: MavFrame };

/**
 * MAVLink CRC-16/MCRF4XX ("X.25") accumulator, seeded 0xFFFF, finalised with
 * the message's CRC_EXTRA byte.
 */
export function mavlinkCrc(bytes: Buffer, crcExtra: number): number {
  let crc = 0xffff;
  const accumulate = (b: number) => {
    let tmp = b ^ (crc & 0xff);
    tmp = (tmp ^ (tmp << 4)) & 0xff;
    crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
  };
  for (const b of bytes) accumulate(b);
  accumulate(crcExtra);
  return crc & 0xffff;
}

/**
 * Encode a MAVLink v2 frame for transmission. Applies v2 payload truncation
 * (trailing zero bytes removed, min length 1) and appends the CRC computed
 * with the supplied CRC_EXTRA seed. Unsigned frames only.
 */
export function encodeV2(params: {
  msgid: number;
  payload: Buffer;
  crcExtra: number;
  seq: number;
  sysid?: number;
  compid?: number;
}): Buffer {
  const { msgid, crcExtra } = params;
  const sysid = params.sysid ?? 255; // GCS convention
  const compid = params.compid ?? 190; // MAV_COMP_ID_MISSIONPLANNER
  const seq = params.seq & 0xff;

  // v2 payload truncation.
  let end = params.payload.length;
  while (end > 1 && params.payload[end - 1] === 0) end--;
  const payload = params.payload.subarray(0, end);

  const header = Buffer.from([
    0x00, // incompat_flags
    0x00, // compat_flags
    seq,
    sysid,
    compid,
    msgid & 0xff,
    (msgid >> 8) & 0xff,
    (msgid >> 16) & 0xff,
  ]);

  // CRC is over [len, ...header, ...payload] then CRC_EXTRA.
  const crcInput = Buffer.concat([
    Buffer.from([payload.length]),
    header,
    payload,
  ]);
  const crc = mavlinkCrc(crcInput, crcExtra);

  return Buffer.concat([
    Buffer.from([MAVLINK_STX_V2, payload.length]),
    header,
    payload,
    Buffer.from([crc & 0xff, (crc >> 8) & 0xff]),
  ]);
}
