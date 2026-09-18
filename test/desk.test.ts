import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { Desk } from '../src/eliot/desk.ts';
import type { Transport } from '../src/eliot/desk.ts';
import { Cmd, Report, encode } from '../src/eliot/protocol.ts';
import type { Frame } from '../src/eliot/protocol.ts';

const MIN = 700;
const MAX = 1280;

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** Build the report frame the control box would send. */
function report(command: number, params: number[]): Frame {
  return { address: 0xf2, command, params: Buffer.from(params) };
}

const be = (mm: number) => [(mm >> 8) & 0xff, mm & 0xff];

/**
 * A control box that answers requests and moves when pulsed, with the timing
 * measured on real hardware: ~22 mm/s, reports every 150 ms, 18 mm of coast.
 */
class FakeDesk extends EventEmitter implements Transport {
  connected = true;
  heightMm: number;
  sent: number[] = [];
  /** Set to make every write fail, as a dropped link does. */
  failWrites = false;
  /** Set to pin the desk in place however hard it is pushed. */
  blocked = false;

  #lastPulse = 0;
  #reporter: NodeJS.Timeout;
  #mover: NodeJS.Timeout;

  constructor(startMm = 880) {
    super();
    this.heightMm = startMm;
    this.#mover = setInterval(() => this.#advance(), 20);
    this.#reporter = setInterval(() => {
      if (Date.now() - this.#lastPulse < 900) {
        this.emit('frame', report(Report.HEIGHT, [...be(Math.round(this.heightMm)), 0x07]));
      }
    }, 150);
  }

  #advance(): void {
    if (this.blocked || Date.now() - this.#lastPulse >= 900) {
      return;
    }
    const last = this.sent[this.sent.length - 1];
    this.heightMm += (last === Cmd.RAISE ? 1 : -1) * 22 * 0.02;
  }

  async send(command: number): Promise<void> {
    if (this.failWrites) {
      throw new Error('write failed');
    }
    this.sent.push(command);
    if (command === Cmd.RAISE || command === Cmd.LOWER) {
      this.#lastPulse = Date.now();
      return;
    }
    if (command === Cmd.SETTINGS) {
      this.emit('frame', report(Report.HEIGHT, [...be(Math.round(this.heightMm)), 0x07]));
    }
    if (command === Cmd.LIMITS) {
      this.emit('frame', report(Report.LIMIT_FLAGS, [0x11]));
      this.emit('frame', report(Report.LIMIT_MAX, be(MAX)));
      this.emit('frame', report(Report.LIMIT_MIN, be(MIN)));
    }
    if (command === Cmd.RANGE) {
      this.emit('frame', report(Report.RANGE, [...be(1285), ...be(642)]));
    }
  }

  async start(): Promise<void> {
    this.emit('connected');
  }

  async close(): Promise<void> {
    clearInterval(this.#reporter);
    clearInterval(this.#mover);
    this.connected = false;
  }

  /** Pull the plug the way BlueZ does. */
  drop(): void {
    this.connected = false;
    this.emit('disconnected');
  }

  /** Move the desk as if somebody pressed the handset. */
  handset(toMm: number): void {
    this.heightMm = toMm;
    this.emit('frame', report(Report.HEIGHT, [...be(toMm), 0x07]));
  }
}

/** Bring a desk up with its state loaded, the way a real connect does. */
async function ready(startMm = 880) {
  const box = new FakeDesk(startMm);
  const desk = new Desk(box, silent, { idlePollMs: 0 });
  await desk.start();
  await tick(1400);
  return { box, desk };
}

test('connecting loads height and limits', async () => {
  const { box, desk } = await ready();

  assert.equal(desk.state.connected, true);
  assert.equal(desk.state.heightMm, 880);
  assert.equal(desk.minMm, MIN);
  assert.equal(desk.maxMm, MAX);
  assert.equal(desk.state.position, 31);
  await desk.close();
  await box.close();
});

test('a move drives the desk and lands on target', async () => {
  const { box, desk } = await ready(880);

  const outcome = await desk.moveTo(60);

  assert.equal(outcome, 'arrived');
  await tick(400);
  // 60% of 700–1280 is 1048 mm.
  assert.ok(Math.abs(box.heightMm - 1048) < 25, `landed at ${box.heightMm}`);
  assert.ok(box.sent.includes(Cmd.RAISE));
  assert.ok(!box.sent.includes(Cmd.LOWER), 'never reversed');
  await desk.close();
  await box.close();
});

test('a lower target drives downwards', async () => {
  const { box, desk } = await ready(1100);

  assert.equal(await desk.moveTo(20), 'arrived');
  assert.ok(box.heightMm < 1100);
  assert.ok(box.sent.includes(Cmd.LOWER));
  assert.ok(!box.sent.includes(Cmd.RAISE));
  await desk.close();
  await box.close();
});

test('a new target supersedes the one in flight', async () => {
  const { box, desk } = await ready(880);

  const first = desk.moveTo(90);
  await tick(300);
  const second = desk.moveTo(40);

  assert.equal(await first, 'superseded');
  assert.equal(await second, 'arrived');
  await desk.close();
  await box.close();
});

test('stop ends the move and stops the pulses', async () => {
  const { box, desk } = await ready(880);

  const move = desk.moveTo(100);
  await tick(300);
  desk.stop();

  assert.equal(await move, 'superseded');
  const after = box.sent.length;
  await tick(500);
  assert.equal(box.sent.length, after, 'no pulses after stop');
  assert.equal(desk.state.moving, null);
  await desk.close();
  await box.close();
});

test('a blocked desk ends the move as stalled', async () => {
  const { box, desk } = await ready(880);
  box.blocked = true;

  assert.equal(await desk.moveTo(100), 'stalled');
  await desk.close();
  await box.close();
});

test('losing the link mid-move ends it as disconnected', async () => {
  const { box, desk } = await ready(880);

  const move = desk.moveTo(100);
  await tick(300);
  box.drop();

  assert.equal(await move, 'disconnected');
  assert.equal(desk.state.connected, false);
  await desk.close();
  await box.close();
});

test('the handset moving the desk updates the target too', async () => {
  const { box, desk } = await ready(880);

  box.handset(1048);
  await tick(50);

  assert.equal(desk.state.heightMm, 1048);
  assert.equal(desk.state.position, 60);
  // Crucially the target follows, so nothing tries to drive it back.
  assert.equal(desk.state.target, 60);
  await desk.close();
  await box.close();
});

test('moving before the desk has reported is refused, not guessed', async () => {
  const box = new FakeDesk(880);
  const desk = new Desk(box, silent, { idlePollMs: 0 });

  assert.equal(await desk.moveTo(50), 'refused');
  assert.deepEqual(box.sent, [], 'and sends nothing');
  await box.close();
});

test('clearing a soft limit falls back to the physical range', async () => {
  const { box, desk } = await ready(880);
  assert.equal(desk.maxMm, MAX);

  box.emit('frame', report(Report.LIMIT_FLAGS, [0x10]));
  await tick(20);

  assert.equal(desk.maxMm, 1285, 'stale soft maximum must not linger');
  assert.equal(desk.minMm, MIN);
  await desk.close();
  await box.close();
});

test('a failing write does not stall the loop, it ends as lost', async () => {
  const { box, desk } = await ready(880);
  box.failWrites = true;

  assert.equal(await desk.moveTo(100), 'lost');
  await desk.close();
  await box.close();
});
