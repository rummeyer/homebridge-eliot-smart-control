import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ADDR_DESK,
  Cmd,
  EOM,
  FrameReader,
  Report,
  checksum,
  encode,
  readHeight,
} from '../src/eliot/protocol.ts';

/** Build a desk-to-handset frame the way the control box would. */
const deskFrame = (command: number, params: number[] = []) =>
  Buffer.from([
    ADDR_DESK,
    ADDR_DESK,
    command,
    params.length,
    ...params,
    checksum(command, params),
    EOM,
  ]);

test('a parameterless command matches the documented bytes', () => {
  // The frame the ESPHome config sends for "request settings", byte for byte.
  assert.deepEqual([...encode(Cmd.SETTINGS)], [0xf1, 0xf1, 0x07, 0x00, 0x07, 0x7e]);
  assert.deepEqual([...encode(Cmd.RAISE)], [0xf1, 0xf1, 0x01, 0x00, 0x01, 0x7e]);
  assert.deepEqual([...encode(Cmd.LIMITS)], [0xf1, 0xf1, 0x20, 0x00, 0x20, 0x7e]);
});

test('the checksum covers command, length and params', () => {
  // Set units to inches: 0x0E + 0x01 + 0x01 = 0x10.
  assert.deepEqual([...encode(0x0e, [0x01])], [0xf1, 0xf1, 0x0e, 0x01, 0x01, 0x10, 0x7e]);
});

test('the checksum wraps rather than overflowing a byte', () => {
  assert.equal(checksum(0xff, [0xff, 0xff]), (0xff + 2 + 0xff + 0xff) & 0xff);
});

test('a height report decodes to millimetres', () => {
  const reader = new FrameReader();
  const [frame] = reader.push(deskFrame(Report.HEIGHT, [0x05, 0x06, 0x07]));

  assert.equal(frame.command, Report.HEIGHT);
  assert.equal(readHeight(frame.params), 1286);
});

test('0x7E inside a payload does not truncate the frame', () => {
  // 115.0 cm is 0x047E. Scanning for the terminator would cut the frame here;
  // this is the case that makes length-driven parsing worth the trouble.
  const reader = new FrameReader();
  const [frame] = reader.push(deskFrame(Report.HEIGHT, [0x04, 0x7e, 0x07]));

  assert.equal(readHeight(frame.params), 1150);
});

test('frames split across chunks are reassembled', () => {
  const reader = new FrameReader();
  const whole = deskFrame(Report.HEIGHT, [0x04, 0xd2, 0x0f]);

  for (const cut of [1, 3, 4, 6]) {
    reader.reset();
    assert.deepEqual(reader.push(whole.subarray(0, cut)), [], `nothing yet after ${cut} bytes`);
    const [frame] = reader.push(whole.subarray(cut));
    assert.equal(readHeight(frame.params), 1234);
  }
});

test('several frames in one chunk all come back, in order', () => {
  const reader = new FrameReader();
  const frames = reader.push(
    Buffer.concat([
      deskFrame(Report.POSITION_1, [0x02, 0x8a]),
      deskFrame(Report.POSITION_2, [0x04, 0xb0]),
      deskFrame(Report.HEIGHT, [0x02, 0x8a, 0x07]),
    ]),
  );

  assert.deepEqual(
    frames.map((f) => f.command),
    [Report.POSITION_1, Report.POSITION_2, Report.HEIGHT],
  );
  assert.equal(readHeight(frames[1].params), 1200);
});

test('leading garbage is skipped and the next good frame still arrives', () => {
  const reader = new FrameReader();
  const frames = reader.push(
    Buffer.concat([Buffer.from([0x00, 0xf2, 0xaa, 0x13]), deskFrame(Report.UNITS, [0x00])]),
  );

  assert.equal(frames.length, 1);
  assert.equal(frames[0].command, Report.UNITS);
});

test('a frame with a bad checksum is dropped, not returned', () => {
  const reader = new FrameReader();
  const corrupt = deskFrame(Report.HEIGHT, [0x05, 0x06, 0x07]);
  corrupt[corrupt.length - 2] ^= 0xff;

  const frames = reader.push(Buffer.concat([corrupt, deskFrame(Report.UNITS, [0x01])]));

  assert.deepEqual(
    frames.map((f) => f.command),
    [Report.UNITS],
  );
});

test('the physical range report yields both ends', () => {
  const reader = new FrameReader();
  // Observed on a Jarvis: 05 14 02 8A — 1300 mm upper, 650 mm lower.
  const [frame] = reader.push(deskFrame(Report.RANGE, [0x05, 0x14, 0x02, 0x8a]));

  assert.equal(readHeight(frame.params, 0), 1300);
  assert.equal(readHeight(frame.params, 2), 650);
});
