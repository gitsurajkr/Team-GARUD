import { EventEmitter } from "node:events";
import dgram from "node:dgram";
import net from "node:net";
import { MavlinkSplitter, type MavFrame } from "./protocol";
import type { LinkOptions } from "../../shared/types";

/**
 * Transport-agnostic MAVLink link. Owns exactly one connection (UDP / TCP /
 * serial) over the LOCAL network only — no external network is used (mission
 * brief section 7). Feeds inbound bytes through a frame splitter and re-emits
 * decoded frames; `send()` writes a pre-encoded frame back to the vehicle.
 *
 * Events:
 *   "frame"  (frame: MavFrame)
 *   "open"
 *   "close"
 *   "error"  (err: Error)
 */
export class MavlinkLink extends EventEmitter {
  private readonly splitter = new MavlinkSplitter();
  private udp?: dgram.Socket;
  private tcp?: net.Socket;
  private serial?: { write: (b: Buffer) => void; close: () => void };
  private udpRemote?: { address: string; port: number };
  private opts?: LinkOptions;

  get endpoint(): string {
    if (!this.opts) return "";
    const o = this.opts;
    if (o.transport === "serial") return `serial://${o.path}@${o.baudRate ?? 57600}`;
    return `${o.transport}://${o.host ?? "0.0.0.0"}:${o.port ?? 14550}`;
  }

  open(opts: LinkOptions): void {
    this.close();
    this.opts = opts;
    switch (opts.transport) {
      case "udp":
        this.openUdp(opts);
        break;
      case "tcp":
        this.openTcp(opts);
        break;
      case "serial":
        this.openSerial(opts);
        break;
    }
  }

  private openUdp(opts: LinkOptions): void {
    const sock = dgram.createSocket("udp4");
    this.udp = sock;
    sock.on("message", (msg, rinfo) => {
      // Learn the vehicle's address from the first datagram so we can reply.
      this.udpRemote = { address: rinfo.address, port: rinfo.port };
      this.ingest(msg);
    });
    sock.on("error", (err) => this.emit("error", err));
    sock.on("listening", () => this.emit("open"));
    sock.bind(opts.port ?? 14550, opts.host === "0.0.0.0" ? undefined : opts.host);
  }

  private openTcp(opts: LinkOptions): void {
    const sock = net.createConnection(
      { host: opts.host ?? "127.0.0.1", port: opts.port ?? 5760 },
      () => this.emit("open"),
    );
    this.tcp = sock;
    sock.on("data", (data) => this.ingest(data));
    sock.on("error", (err) => this.emit("error", err));
    sock.on("close", () => this.emit("close"));
  }

  private openSerial(opts: LinkOptions): void {
    // serialport is an optional (native) dependency; required lazily so the
    // default UDP link works without it installed.
    let SerialPortCtor: unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      SerialPortCtor = require("serialport").SerialPort;
    } catch {
      this.emit("error", new Error("serialport is not installed; run `npm i serialport`"));
      return;
    }
    const Ctor = SerialPortCtor as new (o: { path: string; baudRate: number }) => {
      write: (b: Buffer) => void;
      close: () => void;
      on: (ev: string, cb: (arg: unknown) => void) => void;
    };
    const port = new Ctor({ path: opts.path ?? "COM3", baudRate: opts.baudRate ?? 57600 });
    port.on("open", () => this.emit("open"));
    port.on("data", (data) => this.ingest(data as Buffer));
    port.on("error", (err) => this.emit("error", err as Error));
    this.serial = port;
  }

  private ingest(bytes: Buffer): void {
    for (const frame of this.splitter.push(bytes)) {
      this.emit("frame", frame as MavFrame);
    }
  }

  /** Send a pre-encoded MAVLink frame to the vehicle. */
  send(frame: Buffer): void {
    if (this.udp) {
      if (!this.udpRemote) return; // haven't heard from the vehicle yet
      this.udp.send(frame, this.udpRemote.port, this.udpRemote.address);
    } else if (this.tcp) {
      this.tcp.write(frame);
    } else if (this.serial) {
      this.serial.write(frame);
    }
  }

  close(): void {
    this.udp?.close();
    this.tcp?.destroy();
    this.serial?.close();
    this.udp = this.tcp = this.serial = undefined;
    this.udpRemote = undefined;
  }
}
