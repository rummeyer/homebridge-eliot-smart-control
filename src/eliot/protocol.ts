/**
 * Wire-level framing for the Eliot control box.
 *
 * The Smart Dongle is a CC2541 acting as a transparent BLE-to-UART bridge: it
 * carries bytes between the phone and the control box's second serial port and
 * adds nothing of its own. So this module speaks the control box's protocol,
 * not a Bluetooth one, and the BLE layer in link.ts only has to move buffers.
 *
 * The framing below is the Jiecang/Fully handset protocol, documented by
 * phord/Jarvis and Rocka84/jiecang_desk_controller. It is a *hypothesis* for
 * Eliot until tools/eliot-probe.js confirms it against real hardware — see
 * docs/PROTOCOL.md for what is verified and what is not.
 */

/** Sender address, repeated twice at the start of every frame. */
export const ADDR_HANDSET = 0xf1;
/** The control box's own address; frames from the desk start `F2 F2`. */
export const ADDR_DESK = 0xf2;
/** End of message. Also a legal payload byte — see {@link FrameReader}. */
export const EOM = 0x7e;

/** Commands we send towards the control box. */
export const Cmd = {
  /** Raise by one step. Held movement means repeating this, not a flag. */
  RAISE: 0x01,
  /** Lower by one step. */
  LOWER: 0x02,
  /** Move to memory position 1. */
  MOVE_1: 0x05,
  /** Move to memory position 2. */
  MOVE_2: 0x06,
  /** Request memory positions and settings; the desk answers with several frames. */
  SETTINGS: 0x07,
  /** Request the physical travel range. Answered by {@link Report.RANGE}. */
  RANGE: 0x0c,
  /** Request which soft limits are set. Answered by {@link Report.LIMIT_FLAGS}. */
  LIMITS: 0x20,
  /** Move to memory position 3. */
  MOVE_3: 0x27,
  /** Move to memory position 4. */
  MOVE_4: 0x28,
  /** Poll message; wakes a control box that has gone quiet. */
  WAKE: 0x29,
} as const;

/** Frames the control box sends back. */
export const Report = {
  /** Current height. Params `[hi, lo, ?]`, big-endian tenths of a centimetre. */
  HEIGHT: 0x01,
  /** Physical travel range. Params `[maxHi, maxLo, minHi, minLo]`. */
  RANGE: 0x07,
  /** Display units: 0 = cm, 1 = inches. */
  UNITS: 0x0e,
  /** Which soft limits are set: bit 0 = max, bit 4 = min. */
  LIMIT_FLAGS: 0x20,
  /** Soft maximum height, if one is set. */
  LIMIT_MAX: 0x21,
  /** Soft minimum height, if one is set. */
  LIMIT_MIN: 0x22,
  /** Memory position 1 height. */
  POSITION_1: 0x25,
  /** Memory position 2 height. */
  POSITION_2: 0x26,
  /** Memory position 3 height. */
  POSITION_3: 0x27,
  /** Memory position 4 height. */
  POSITION_4: 0x28,
} as const;

/** A decoded frame, before any meaning is read into its params. */
export interface Frame {
  /** {@link ADDR_HANDSET} or {@link ADDR_DESK}. */
  address: number;
  /** Command or report code. */
  command: number;
  /** Payload bytes, `length` of them. */
  params: Buffer;
}

/** Sum of command, length and params, low byte. */
export function checksum(command: number, params: Buffer | number[]): number {
  const bytes = Buffer.from(params);
  let sum = command + bytes.length;
  for (const b of bytes) {
    sum += b;
  }
  return sum & 0xff;
}

/** Build a frame to send to the control box. */
export function encode(command: number, params: Buffer | number[] = []): Buffer {
  const bytes = Buffer.from(params);
  return Buffer.concat([
    Buffer.from([ADDR_HANDSET, ADDR_HANDSET, command, bytes.length]),
    bytes,
    Buffer.from([checksum(command, bytes), EOM]),
  ]);
}

/**
 * Reassembles frames from a byte stream.
 *
 * Deliberately length-driven rather than scanning for the `0x7E` terminator,
 * which is how the ESPHome implementation does it and where it admits it
 * breaks. The terminator is not escaped, and `0x7E` is a perfectly ordinary
 * payload byte: a height of 115.0 cm is `04 7E`, so a desk parked at a normal
 * standing height would truncate every height report. Reading the length byte
 * and verifying the checksum costs nothing and does not have that hole.
 */
export class FrameReader {
  private buffer = Buffer.alloc(0);

  /** Feed received bytes; returns whatever complete frames they finished. */
  push(chunk: Buffer): Frame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: Frame[] = [];

    for (;;) {
      const frame = this.shift();
      if (!frame) {
        break;
      }
      frames.push(frame);
    }

    return frames;
  }

  /** Drop any partial frame, after a reconnect or a gap in the stream. */
  reset(): void {
    this.buffer = Buffer.alloc(0);
  }

  /** Take one frame off the front of the buffer, resyncing past any garbage. */
  private shift(): Frame | null {
    while (this.buffer.length >= 2) {
      const address = this.buffer[0];
      if ((address !== ADDR_DESK && address !== ADDR_HANDSET) || this.buffer[1] !== address) {
        this.buffer = this.buffer.subarray(1);
        continue;
      }

      // Header is address twice, command, length; then params, checksum, EOM.
      if (this.buffer.length < 4) {
        return null;
      }
      const command = this.buffer[2];
      const length = this.buffer[3];
      const total = 4 + length + 2;
      if (this.buffer.length < total) {
        return null;
      }

      const params = this.buffer.subarray(4, 4 + length);
      const valid =
        this.buffer[total - 1] === EOM && this.buffer[total - 2] === checksum(command, params);

      if (!valid) {
        // A bad frame means we locked onto the wrong offset, so give up only
        // this start byte rather than the whole window: the real header may
        // begin one byte in.
        this.buffer = this.buffer.subarray(1);
        continue;
      }

      const frame: Frame = { address, command, params: Buffer.from(params) };
      this.buffer = this.buffer.subarray(total);
      return frame;
    }

    return null;
  }
}

/**
 * Read a height from two big-endian bytes.
 *
 * The control box counts in tenths of its display unit, so this is millimetres
 * with the display in centimetres and hundredths of an inch with it in inches.
 * The plugin keeps everything in millimetres and leaves the display alone.
 */
export function readHeight(params: Buffer, offset = 0): number {
  return params.readUInt16BE(offset);
}
