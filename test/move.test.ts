import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_MOVE_OPTIONS,
  MoveController,
  heightToPercent,
  percentToHeight,
} from '../src/eliot/move.ts';

/** The desk this was verified against: soft limits 700–1280 mm. */
const MIN = 700;
const MAX = 1280;

/**
 * Drive a controller through simulated time, with the desk moving at a given
 * speed for as long as it is being pulsed. Returns how it ended and where.
 */
function simulate(
  target: number,
  start: number,
  {
    speed = 30,
    stopAfterMs = Infinity,
    reportEveryMs = 250,
    coastMm = 0,
    limitMs = 120_000,
  }: {
    speed?: number;
    stopAfterMs?: number;
    reportEveryMs?: number;
    coastMm?: number;
    limitMs?: number;
  } = {},
) {
  const tickMs = 50;
  let now = 0;
  let height = start;
  let lastReport = 0;
  let lastPulse: number | null = null;
  const controller = new MoveController(target, start, now);
  const sent: string[] = [];

  for (; now < limitMs; now += tickMs) {
    // The desk keeps moving only while step commands keep coming.
    const driven = lastPulse !== null && now - lastPulse < 900 && now < stopAfterMs;
    if (driven) {
      height += ((controller.direction === 'up' ? 1 : -1) * speed * tickMs) / 1000;
    }
    if (now - lastReport >= reportEveryMs) {
      lastReport = now;
      controller.report(Math.round(height), now);
    }

    const { send, result } = controller.step(now);
    if (send) {
      sent.push(send);
      lastPulse = now;
    }
    if (result) {
      // Whatever momentum the desk has left after the final pulse.
      height += (controller.direction === 'up' ? 1 : -1) * coastMm;
      return { result, height: Math.round(height), sent, now };
    }
  }
  return { result: 'never-finished' as const, height: Math.round(height), sent, now };
}

test('a target under the tolerance is not a move at all', () => {
  const controller = new MoveController(880, 883, 0);
  const { send, result } = controller.step(0);

  assert.equal(result, 'arrived');
  assert.equal(send, null, 'must not send a stray step command');
});

test('driving up arrives within tolerance of the target', () => {
  const run = simulate(1204, 880);

  assert.equal(run.result, 'arrived');
  assert.ok(Math.abs(run.height - 1204) <= DEFAULT_MOVE_OPTIONS.approachMm + 2, `landed at ${run.height}`);
  assert.ok(run.sent.every((s) => s === 'up'));
});

test('driving down arrives too, and only ever sends "down"', () => {
  const run = simulate(MIN, 1204);

  assert.equal(run.result, 'arrived');
  assert.ok(Math.abs(run.height - MIN) <= DEFAULT_MOVE_OPTIONS.approachMm + 2, `landed at ${run.height}`);
  assert.ok(run.sent.every((s) => s === 'down'));
});

test('stopping short of the target leaves room for coasting', () => {
  // The drift measured on real hardware: 17 mm up, 19 mm down. Neither may
  // carry the desk meaningfully past the target.
  for (const coastMm of [17, 19]) {
    const up = simulate(1000, 800, { coastMm });
    assert.equal(up.result, 'arrived');
    assert.ok(Math.abs(up.height - 1000) <= 8, `up overshot to ${up.height} with ${coastMm} mm coast`);

    const down = simulate(800, 1000, { coastMm });
    assert.equal(down.result, 'arrived');
    assert.ok(Math.abs(down.height - 800) <= 8, `down overshot to ${down.height} with ${coastMm} mm coast`);
  }
});

test('a move shorter than the stopping distance sends nothing at all', () => {
  // Asking for 10 mm when the desk needs 18 mm to stop would mean pulsing and
  // then hunting. Arriving without moving is the honest answer.
  const controller = new MoveController(890, 880, 0);
  const { send, result } = controller.step(0);

  assert.equal(result, 'arrived');
  assert.equal(send, null);
});

test('a desk that stops moving under load is reported as stalled', () => {
  const run = simulate(1280, 700, { stopAfterMs: 3000 });

  assert.equal(run.result, 'stalled');
  assert.ok(run.height < 1280, 'and nowhere near the target');
});

test('silence is reported as lost, not mistaken for a stall', () => {
  const controller = new MoveController(1280, 700, 0);
  let last: ReturnType<MoveController['step']> = { send: null, result: null };

  // Reports stop immediately; only the clock advances.
  for (let now = 0; now <= 10_000 && !last.result; now += 100) {
    last = controller.step(now);
  }

  assert.equal(last.result, 'lost');
});

test('a desk crawling far too slowly hits the deadline', () => {
  // 5 mm/s: fast enough to clear the stall check, far too slow for 580 mm
  // inside the deadline, so this exercises the deadline and nothing else.
  const run = simulate(1280, 700, { speed: 5 });

  assert.equal(run.result, 'timeout');
});

test('the deadline scales with distance, so long moves are not cut off', () => {
  const short = new MoveController(760, 700, 0);
  const long = new MoveController(1280, 700, 0);

  assert.ok(long.deadline > short.deadline);
  // 580 mm at the 8 mm/s floor is 72.5 s, plus slack.
  assert.equal(long.deadline, 72_500 + DEFAULT_MOVE_OPTIONS.deadlineSlackMs);
});

test('pulses are paced, not sent on every tick', () => {
  const controller = new MoveController(1280, 700, 0);
  let sent = 0;
  for (let now = 0; now < 1000; now += 50) {
    controller.report(700, now);
    if (controller.step(now).send) {
      sent += 1;
    }
  }

  // 1000 ms at a 400 ms pulse: one immediately, then two more.
  assert.equal(sent, 3);
});

test('the direction is fixed when the move starts', () => {
  assert.equal(new MoveController(1200, 800, 0).direction, 'up');
  assert.equal(new MoveController(800, 1200, 0).direction, 'down');
});

test('percent maps onto the soft limits, not the physical range', () => {
  assert.equal(heightToPercent(MIN, MIN, MAX), 0);
  assert.equal(heightToPercent(MAX, MIN, MAX), 100);
  assert.equal(heightToPercent(990, MIN, MAX), 50);
  // Below the soft minimum the desk is still at 0%, not negative.
  assert.equal(heightToPercent(642, MIN, MAX), 0);
});

test('percent converts back to a height inside the limits', () => {
  assert.equal(percentToHeight(0, MIN, MAX), MIN);
  assert.equal(percentToHeight(100, MIN, MAX), MAX);
  assert.equal(percentToHeight(50, MIN, MAX), 990);
  assert.equal(percentToHeight(150, MIN, MAX), MAX);
  assert.equal(percentToHeight(-10, MIN, MAX), MIN);
});

test('a degenerate limit range does not divide by zero', () => {
  assert.equal(heightToPercent(900, 900, 900), 0);
});
