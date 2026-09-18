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

  /** What the control box does by itself after a memory command. */
  #driveTo(target: number): void {
    const step = () => {
      const delta = target - this.heightMm;
      if (Math.abs(delta) < 1) {
        this.heightMm = target;
        this.emit('frame', report(Report.HEIGHT, [...be(Math.round(this.heightMm)), 0x07]));
        return;
      }
      this.heightMm += Math.sign(delta) * Math.min(Math.abs(delta), 8);
      this.emit('frame', report(Report.HEIGHT, [...be(Math.round(this.heightMm)), 0x07]));
      setTimeout(step, 30).unref?.();
    };
    setTimeout(step, 30).unref?.();
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
      this.emit('frame', report(Report.POSITION_1, be(801)));
      this.emit('frame', report(Report.POSITION_2, be(1204)));
      this.emit('frame', report(Report.POSITION_3, be(1000)));
      this.emit('frame', report(Report.POSITION_4, be(0)));
    }
    const memory = { [Cmd.MOVE_1]: 801, [Cmd.MOVE_2]: 1204, [Cmd.MOVE_3]: 1000 }[command];
    if (memory !== undefined && !this.blocked) {
      // The real control box runs its own ramp and reports as it goes; one
      // command is all it needs.
      this.#driveTo(memory);
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
  assert.equal(desk.state.ready, true);
  assert.equal(desk.state.heightMm, 880);
  assert.equal(desk.minMm, MIN);
  assert.equal(desk.maxMm, MAX);
  assert.equal(desk.state.position, 31);
  await desk.close();
  await box.close();
});

test('nothing is published as ready before the limits arrive', async () => {
  const box = new FakeDesk(880);
  const desk = new Desk(box, silent, { idlePollMs: 0 });
  const seen: boolean[] = [];
  desk.on('change', (s) => seen.push(s.ready));

  await desk.start();
  await tick(400);
  assert.equal(desk.state.ready, false, 'limits have not landed yet');

  await tick(1200);
  assert.equal(desk.state.ready, true);
  assert.ok(!seen.slice(0, -1).every(Boolean), 'and it was not ready from the start');

  await desk.close();
  await box.close();
});

test('a dropped link makes the state untrustworthy again', async () => {
  const { box, desk } = await ready(880);
  assert.equal(desk.state.ready, true);

  box.drop();
  await tick(20);

  assert.equal(desk.state.ready, false, 'the desk can be moved by hand while away');
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

test('measurement noise is not mistaken for somebody at the handset', async () => {
  const { box, desk } = await ready(880);
  const target = desk.state.target;

  // What the control box actually does on a desk nobody is touching: the
  // reported height wanders a few millimetres either way, indefinitely.
  for (const mm of [884, 879, 883, 877, 882, 878, 884, 880, 885, 879]) {
    box.handset(mm);
    await tick(10);
  }

  assert.equal(desk.state.target, target, 'the target must not drift with the noise');
  await desk.close();
  await box.close();
});

test('a slow handset move is caught even in steps below the threshold', async () => {
  const { box, desk } = await ready(880);

  // Comparing consecutive readings would miss this entirely: no single step
  // reaches the threshold, but the desk ends up 100 mm higher.
  for (let mm = 890; mm <= 980; mm += 10) {
    box.handset(mm);
    await tick(10);
  }

  assert.equal(desk.state.heightMm, 980);
  assert.equal(desk.state.target, desk.state.position, 'the target followed it up');
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

test('a successful move keeps the target that was asked for', async () => {
  const { box, desk } = await ready(880);

  assert.equal(await desk.moveTo(60), 'arrived');
  assert.equal(desk.state.target, 60, 'the request must survive its own success');

  // And the coast afterwards must not be mistaken for someone at the handset.
  box.handset(Math.round(box.heightMm) + 12);
  await tick(50);
  assert.equal(desk.state.target, 60, 'coasting must not drag the target along');

  await desk.close();
  await box.close();
});

test('a failed move gives up the target instead of pretending', async () => {
  const { box, desk } = await ready(880);
  box.blocked = true;

  assert.equal(await desk.moveTo(100), 'stalled');
  assert.equal(desk.state.target, desk.state.position, 'not still heading for 100%');

  await desk.close();
  await box.close();
});

test('the handset is still noticed once the settling window has passed', async () => {
  const { box, desk } = await ready(880);

  assert.equal(await desk.moveTo(60), 'arrived');
  await tick(3100);
  box.handset(760);
  await tick(50);

  assert.equal(desk.state.position, 10);
  assert.equal(desk.state.target, 10, 'a real handset move does move the target');

  await desk.close();
  await box.close();
});

test('the memory positions are read from the desk, unset ones as null', async () => {
  const { box, desk } = await ready(880);

  assert.deepEqual(desk.state.memories, [801, 1204, 1000, null]);
  await desk.close();
  await box.close();
});

test('a memory move sends one command and lets the control box drive', async () => {
  const { box, desk } = await ready(880);

  const outcome = await desk.moveToMemory(3);

  assert.equal(outcome, 'arrived');
  assert.equal(Math.round(box.heightMm), 1000);
  // One command, not a stream of steps: the box has its own ramp.
  assert.equal(box.sent.filter((c) => c === Cmd.MOVE_3).length, 1);
  assert.ok(!box.sent.includes(Cmd.RAISE), 'no step commands at all');
  await desk.close();
  await box.close();
});

test('an unset memory is refused rather than driving to zero', async () => {
  const { box, desk } = await ready(880);
  const before = box.sent.length;

  assert.equal(await desk.moveToMemory(4), 'refused');
  assert.equal(box.sent.length, before, 'and nothing was sent');
  await desk.close();
  await box.close();
});

test('a memory move that goes nowhere ends as stalled', async () => {
  const { box, desk } = await ready(880);
  box.blocked = true;

  assert.equal(await desk.moveToMemory(2), 'stalled');
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
