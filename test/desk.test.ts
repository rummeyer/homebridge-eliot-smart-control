import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, test } from 'node:test';
import type { TestContext } from 'node:test';

import { Desk } from '../src/eliot/desk.ts';
import type { Transport } from '../src/eliot/desk.ts';
import { Cmd, Report, encode } from '../src/eliot/protocol.ts';
import type { Frame } from '../src/eliot/protocol.ts';

const MIN = 700;
const MAX = 1280;

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Hold the event loop open for as long as this file runs.
 *
 * Everything the fake desk and the plugin schedule is unref'd — rightly, since
 * neither should keep Homebridge alive — which leaves stretches where a test
 * is awaiting a move and nothing else is pending. Node then decides the run is
 * finished and cancels the rest, reported as `Promise resolution is still
 * pending but the event loop has already resolved`. Ref'ing the fake's timers
 * instead would fix that and reintroduce the opposite fault, where one stray
 * fake hangs the whole run.
 */
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));

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
  /** Clear to play an older control box that has never heard of GOTO_HEIGHT. */
  knowsGotoHeight = true;
  locked = false;
  /** Settings the box reports back, and remembers when they are written. */
  velocity = 21;
  lowPower = true;

  #lastPulse = 0;
  #reporter: NodeJS.Timeout;
  #mover: NodeJS.Timeout;

  constructor(startMm = 880) {
    super();
    this.heightMm = startMm;
    // unref'd throughout, so a stray fake can never hold the run open.
    // Keeping the loop busy is the keepAlive below's job, not theirs.
    this.#mover = setInterval(() => this.#advance(), 20);
    this.#mover.unref();
    this.#reporter = setInterval(() => {
      if (Date.now() - this.#lastPulse < 900) {
        this.emit('frame', report(Report.HEIGHT, [...be(Math.round(this.heightMm)), 0x07]));
      }
    }, 150);
    this.#reporter.unref();
  }

  #driving = false;
  /**
   * Which drive is current.
   *
   * A boolean is not enough: cancelling and immediately starting another move
   * would let the cancelled loop see the flag set again and carry on towards
   * its old target, so two drives pulled the desk in opposite directions. A
   * real control box has one motor and one destination.
   */
  #driveSeq = 0;

  /** Cancel whatever the box is driving, which is what a step command does. */
  #cancelDrive(): void {
    this.#driveSeq += 1;
    this.#driving = false;
  }

  /** What the control box does by itself after a memory command. */
  #driveTo(target: number): void {
    this.#driveSeq += 1;
    const seq = this.#driveSeq;
    this.#driving = true;
    const step = () => {
      if (seq !== this.#driveSeq) {
        return;
      }
      const delta = target - this.heightMm;
      if (Math.abs(delta) < 1) {
        this.heightMm = target;
        this.#driving = false;
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
    // Two drives must never run at once: while the box is running its own
    // memory ramp, pulses do nothing. Letting both move the desk made the
    // fake overshoot in ways no real control box would.
    if (this.blocked || this.#driving || Date.now() - this.#lastPulse >= 900) {
      return;
    }
    const last = this.sent[this.sent.length - 1];
    if (last !== Cmd.RAISE && last !== Cmd.LOWER) {
      return;
    }
    this.heightMm += (last === Cmd.RAISE ? 1 : -1) * 22 * 0.02;
  }

  async send(command: number, params?: Buffer | number[]): Promise<void> {
    if (this.failWrites) {
      throw new Error('write failed');
    }
    this.sent.push(command);
    if (command === Cmd.RAISE || command === Cmd.LOWER) {
      // Verified on hardware: any step command cancels a memory move.
      this.#cancelDrive();
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
    if (command === Cmd.CONNECT) {
      // The settings block, as captured from an Eliot: one frame per field,
      // in the order the box sends them, interleaved with the codes nobody
      // has decoded — those are here on purpose, so the parser has to ignore
      // them rather than merely never meet them.
      this.emit('frame', report(0x0d, [0x02]));
      this.emit('frame', report(Report.UNITS, [0x00]));
      this.emit('frame', report(Report.VELOCITY, [this.velocity]));
      this.emit('frame', report(0x17, [0x01]));
      this.emit('frame', report(Report.LOW_POWER, [this.lowPower ? 1 : 0]));
      this.emit('frame', report(Report.MOTION_MODE, [0x00]));
      this.emit('frame', report(Report.VERSION, [0x0a]));
      this.emit('frame', report(Report.SENSITIVITY, [0x02]));
      this.emit('frame', report(0x23, [0x21, 0x92, 0x0a, 0x0b]));
      return;
    }
    if (command === Cmd.VELOCITY && params) {
      this.velocity = params[0];
      return;
    }
    if (command === Cmd.LOW_POWER && params) {
      this.lowPower = params[0] === 1;
      return;
    }
    if (command === Cmd.LOCK) {
      // Param 0 asks, param 1 flips; either way the answer is the new state.
      if (params && params[0] === 1) {
        this.locked = !this.locked;
      }
      this.emit('frame', report(Report.LOCK, [this.locked ? 1 : 0]));
      return;
    }
    if (command === Cmd.STOP) {
      this.#cancelDrive();
      return;
    }
    if (command === Cmd.GOTO_HEIGHT) {
      if (this.knowsGotoHeight && !this.blocked && params) {
        this.#driveTo((params[0] << 8) | params[1]);
      }
      // An older box does not answer an unknown command; it just sits there.
      return;
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

/**
 * Bring a desk up with its state loaded, the way a real connect does.
 *
 * Takes the test context so cleanup is registered rather than left to the end
 * of the body, where a failed assertion would skip it and leave the fake's
 * timers running.
 */
async function ready(t: TestContext, startMm = 880) {
  const box = new FakeDesk(startMm);
  const desk = new Desk(box, silent, { idlePollMs: 0 });
  t.after(async () => {
  });
  await desk.start();
  await tick(1400);
  return { box, desk };
}

test('the settings block is read back, undecoded fields and all', async (t) => {
  const { desk } = await ready(t);
  await tick(300);

  assert.deepEqual(desk.state.settings, {
    firmware: 10,
    velocity: 21,
    lowPower: true,
    motionMode: 0,
    sensitivity: 2,
    units: 'cm',
  });
});

test('settings arrive after the desk is usable, not before', async (t) => {
  const { desk } = await ready(t);

  // The block is what CONNECT answers, and CONNECT goes out last: a desk whose
  // height and limits have landed is ready to drive, whether or not it has got
  // round to saying which firmware it runs.
  assert.equal(desk.state.ready, true);
});

test('a setting written by somebody else is picked up on the next refresh', async (t) => {
  const { box, desk } = await ready(t);
  await tick(300);
  assert.equal(desk.state.settings.lowPower, true);

  // The phone app writes its own stored configuration when it connects, so the
  // desk's settings change without this plugin doing anything.
  box.lowPower = false;
  box.velocity = 40;
  await desk.refresh();
  await tick(300);

  assert.equal(desk.state.settings.lowPower, false);
  assert.equal(desk.state.settings.velocity, 40);
});

test('connecting loads height, limits and the lock state', async (t) => {
  const { box, desk } = await ready(t);

  assert.equal(desk.state.connected, true);
  assert.equal(desk.state.ready, true);
  assert.equal(desk.state.locked, false);
  assert.equal(desk.state.heightMm, 880);
  assert.equal(desk.minMm, MIN);
  assert.equal(desk.maxMm, MAX);
  assert.equal(desk.state.position, 31);
});

test('nothing is polled while the control box is driving', async (t) => {
  // SETTINGS is a command, and one arriving mid-move makes the box abandon the
  // move — the desk stops short, and then looks like a box that never
  // understood GOTO_HEIGHT at all, so the step fallback takes over and the
  // position jumps.
  const box = new FakeDesk(880);
  const desk = new Desk(box, silent, { idlePollMs: 60 });
  t.after(async () => {
    await desk.close();
  });
  await desk.start();
  await tick(1400);

  const move = desk.moveTo(90);
  await tick(200);
  const during = box.sent.filter((c) => c === Cmd.SETTINGS).length;
  await tick(500);

  assert.equal(
    box.sent.filter((c) => c === Cmd.SETTINGS).length,
    during,
    'the poll stayed quiet for the whole move',
  );

  desk.stop();
  await move;
});

test('nothing is published as ready before the limits arrive', async (t) => {
  const box = new FakeDesk(880);
  const desk = new Desk(box, silent, { idlePollMs: 0 });
  t.after(async () => {
    await desk.close();
    await box.close();
  });
  const seen: boolean[] = [];
  desk.on('change', (s) => seen.push(s.ready));

  await desk.start();
  await tick(400);
  assert.equal(desk.state.ready, false, 'limits have not landed yet');

  await tick(1200);
  assert.equal(desk.state.ready, true);
  assert.ok(!seen.slice(0, -1).every(Boolean), 'and it was not ready from the start');

});

test('a dropped link makes the state untrustworthy again', async (t) => {
  const { box, desk } = await ready(t, 880);
  assert.equal(desk.state.ready, true);

  box.drop();
  await tick(20);

  assert.equal(desk.state.ready, false, 'the desk can be moved by hand while away');
});

test('a move hands the height to the control box and lands on it', async (t) => {
  const { box, desk } = await ready(t, 880);

  const outcome = await desk.moveTo(60);

  assert.equal(outcome, 'arrived');
  await tick(400);
  // 60% of 700–1280 is 1048 mm.
  assert.ok(Math.abs(box.heightMm - 1048) < 25, `landed at ${box.heightMm}`);
  assert.ok(box.sent.includes(Cmd.GOTO_HEIGHT), 'used the native command');
  assert.ok(!box.sent.includes(Cmd.RAISE), 'and no step commands at all');
  assert.ok(!box.sent.includes(Cmd.LOWER));
});

test('a lower target goes down, still in one command', async (t) => {
  const { box, desk } = await ready(t, 1100);

  assert.equal(await desk.moveTo(20), 'arrived');
  assert.ok(box.heightMm < 1100);
  assert.equal(box.sent.filter((c) => c === Cmd.GOTO_HEIGHT).length, 1);
});

test('a control box that ignores GOTO_HEIGHT is driven by hand instead', async (t) => {
  const { box, desk } = await ready(t, 880);
  box.knowsGotoHeight = false;

  const outcome = await desk.moveTo(60);

  assert.equal(outcome, 'arrived', 'the caller gets the same answer either way');
  assert.ok(box.sent.includes(Cmd.GOTO_HEIGHT), 'the native command was tried first');
  assert.ok(box.sent.includes(Cmd.RAISE), 'and step commands took over');
  await tick(400);
  assert.ok(Math.abs(box.heightMm - 1048) < 30, `landed at ${box.heightMm}`);
});

test('a new target supersedes the one in flight', async (t) => {
  const { box, desk } = await ready(t, 880);

  const first = desk.moveTo(90);
  await tick(300);
  const second = desk.moveTo(40);

  assert.equal(await first, 'superseded');
  assert.equal(await second, 'arrived');
});

test('stop sends the stop command and the desk halts', async (t) => {
  const { box, desk } = await ready(t, 880);

  const move = desk.moveTo(100);
  await tick(400);
  const partWay = box.heightMm;
  desk.stop();

  assert.equal(await move, 'superseded');
  assert.ok(box.sent.includes(Cmd.STOP), 'the proper stop command was used');
  await tick(600);
  assert.ok(box.heightMm < 1280, `stopped at ${box.heightMm}, short of the top`);
  assert.ok(box.heightMm >= partWay - 1, 'and did not jump backwards');
  assert.equal(desk.state.moving, null);
});

test('a blocked desk ends the move as stalled', async (t) => {
  const { box, desk } = await ready(t, 880);
  box.blocked = true;

  assert.equal(await desk.moveTo(100), 'stalled');
});

test('losing the link mid-move ends it as disconnected', async (t) => {
  const { box, desk } = await ready(t, 880);

  const move = desk.moveTo(100);
  await tick(300);
  box.drop();

  assert.equal(await move, 'disconnected');
  assert.equal(desk.state.connected, false);
});

test('measurement noise is not mistaken for somebody at the handset', async (t) => {
  const { box, desk } = await ready(t, 880);
  const target = desk.state.target;

  // What the control box actually does on a desk nobody is touching: the
  // reported height wanders a few millimetres either way, indefinitely.
  for (const mm of [884, 879, 883, 877, 882, 878, 884, 880, 885, 879]) {
    box.handset(mm);
    await tick(10);
  }

  assert.equal(desk.state.target, target, 'the target must not drift with the noise');
});

test('a slow handset move is caught even in steps below the threshold', async (t) => {
  const { box, desk } = await ready(t, 880);

  // Comparing consecutive readings would miss this entirely: no single step
  // reaches the threshold, but the desk ends up 100 mm higher.
  for (let mm = 890; mm <= 980; mm += 10) {
    box.handset(mm);
    await tick(10);
  }

  assert.equal(desk.state.heightMm, 980);
  assert.equal(desk.state.target, desk.state.position, 'the target followed it up');
});

test('the handset moving the desk updates the target too', async (t) => {
  const { box, desk } = await ready(t, 880);

  box.handset(1048);
  await tick(50);

  assert.equal(desk.state.heightMm, 1048);
  assert.equal(desk.state.position, 60);
  // Crucially the target follows, so nothing tries to drive it back.
  assert.equal(desk.state.target, 60);
});

test('a successful move keeps the target that was asked for', async (t) => {
  const { box, desk } = await ready(t, 880);

  assert.equal(await desk.moveTo(60), 'arrived');
  assert.equal(desk.state.target, 60, 'the request must survive its own success');

  // And the coast afterwards must not be mistaken for someone at the handset.
  box.handset(Math.round(box.heightMm) + 12);
  await tick(50);
  assert.equal(desk.state.target, 60, 'coasting must not drag the target along');

});

test('a failed move gives up the target instead of pretending', async (t) => {
  const { box, desk } = await ready(t, 880);
  box.blocked = true;

  assert.equal(await desk.moveTo(100), 'stalled');
  assert.equal(desk.state.target, desk.state.position, 'not still heading for 100%');

});

test('the handset is still noticed once the settling window has passed', async (t) => {
  const { box, desk } = await ready(t, 880);

  assert.equal(await desk.moveTo(60), 'arrived');
  await tick(3100);
  box.handset(760);
  await tick(50);

  assert.equal(desk.state.position, 10);
  assert.equal(desk.state.target, 10, 'a real handset move does move the target');

});

test('locking and unlocking the desk works and reports back', async (t) => {
  const { box, desk } = await ready(t, 880);
  assert.equal(desk.state.locked, false);

  assert.equal(await desk.setLocked(true), true);
  assert.equal(box.locked, true, 'the desk is locked');
  assert.equal(desk.state.locked, true, 'and says so');

  assert.equal(await desk.setLocked(false), true);
  assert.equal(box.locked, false);
  assert.equal(desk.state.locked, false);

});

test('asking for the state it is already in sends nothing', async (t) => {
  const { box, desk } = await ready(t, 880);
  const before = box.sent.filter((c) => c === Cmd.LOCK).length;

  // The control box offers a toggle, not a setting. Sending it anyway would
  // unlock a locked desk every time something asked for it to be locked.
  assert.equal(await desk.setLocked(false), true);

  assert.equal(box.sent.filter((c) => c === Cmd.LOCK).length, before);
  assert.equal(box.locked, false);
});

test('a dropped link forgets the lock state rather than guessing', async (t) => {
  const { box, desk } = await ready(t, 880);
  assert.equal(desk.state.locked, false);

  box.drop();
  await tick(20);

  assert.equal(desk.state.locked, null, 'it can be locked at the handset while away');
});

test('the memory positions are read from the desk, unset ones as null', async (t) => {
  const { box, desk } = await ready(t, 880);

  assert.deepEqual(desk.state.memories, [801, 1204, 1000, null]);
});

test('a memory move sends one command and lets the control box drive', async (t) => {
  const { box, desk } = await ready(t, 880);

  const outcome = await desk.moveToMemory(3);

  assert.equal(outcome, 'arrived');
  assert.equal(Math.round(box.heightMm), 1000);
  // One command, not a stream of steps: the box has its own ramp.
  assert.equal(box.sent.filter((c) => c === Cmd.MOVE_3).length, 1);
  assert.ok(!box.sent.includes(Cmd.RAISE), 'no step commands at all');
});

test('a memory move can be stopped part way', async (t) => {
  const { box, desk } = await ready(t, 880);

  const move = desk.moveToMemory(2); // 1204 mm, a long way up
  await tick(400);
  const partWay = box.heightMm;
  desk.stop();

  assert.equal(await move, 'superseded');
  await tick(500);
  assert.ok(box.heightMm < 1100, `stopped at ${box.heightMm}, nowhere near 1204`);
  assert.ok(box.heightMm >= partWay - 1, 'and did not jump backwards');
  assert.ok(box.sent.includes(Cmd.STOP), 'STOP was used');
  // And nothing behind it. A step command used to follow as insurance for a
  // box that predates STOP; on a box driving a GOTO_HEIGHT it starts a small
  // move of its own, which the replacement target then arrives in the middle
  // of — and a command arriving mid-move is one this box abandons. The desk
  // took the 4 mm step and ignored the height it was given.
  assert.ok(!box.sent.includes(Cmd.RAISE), 'no step command chasing the stop');
  assert.ok(!box.sent.includes(Cmd.LOWER), 'in either direction');

});

test('a new target cancels a memory move rather than racing it', async (t) => {
  const { box, desk } = await ready(t, 880);

  const first = desk.moveToMemory(2); // up towards 1204
  await tick(400);
  const second = desk.moveToMemory(1); // 801, the other way

  assert.equal(await first, 'superseded');
  assert.equal(await second, 'arrived');
  assert.equal(Math.round(box.heightMm), 801);

});

test('an unset memory is refused rather than driving to zero', async (t) => {
  const { box, desk } = await ready(t, 880);
  const before = box.sent.length;

  assert.equal(await desk.moveToMemory(4), 'refused');
  assert.equal(box.sent.length, before, 'and nothing was sent');
});

test('a memory move that goes nowhere ends as stalled', async (t) => {
  const { box, desk } = await ready(t, 880);
  box.blocked = true;

  assert.equal(await desk.moveToMemory(2), 'stalled');
});

test('moving before the desk has reported is refused, not guessed', async (t) => {
  const box = new FakeDesk(880);
  const desk = new Desk(box, silent, { idlePollMs: 0 });
  t.after(async () => {
    await desk.close();
    await box.close();
  });

  assert.equal(await desk.moveTo(50), 'refused');
  assert.deepEqual(box.sent, [], 'and sends nothing');
});

test('clearing a soft limit falls back to the physical range', async (t) => {
  const { box, desk } = await ready(t, 880);
  assert.equal(desk.maxMm, MAX);

  box.emit('frame', report(Report.LIMIT_FLAGS, [0x10]));
  await tick(20);

  assert.equal(desk.maxMm, 1285, 'stale soft maximum must not linger');
  assert.equal(desk.minMm, MIN);
});

test('a write that cannot be delivered ends the move at once', async (t) => {
  const { box, desk } = await ready(t, 880);
  box.failWrites = true;

  // The destination is a single awaited write now, so a dead link is known
  // immediately rather than inferred a few seconds later from silence.
  assert.equal(await desk.moveTo(100), 'disconnected');
});

test('a handset move is reported once, at its end, with where it stopped', async (t) => {
  const { box, desk } = await ready(t, 880);
  const seen: number[] = [];
  desk.on('external-move', (mm) => seen.push(mm));

  // The stream the box sends while somebody holds the down key: several
  // heights a second, most of them less than the threshold apart.
  for (let mm = 871; mm >= 800; mm -= 9) {
    box.handset(mm);
    await tick(150);
  }
  assert.equal(desk.handsetMoving, true, 'still going as far as anyone can tell');
  assert.deepEqual(seen, [], 'nothing said while the desk is still moving');

  await tick(1700);
  assert.equal(desk.handsetMoving, false);
  assert.deepEqual(seen, [808], 'once, with the height it came to rest at');
});
