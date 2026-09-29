import assert from 'node:assert/strict';
import test from 'node:test';

import { TRAVEL_GAP_MS, TravelTracker } from '../src/travel.ts';

/** Feed heights at a steady interval, returning whatever journeys they close. */
function drive(tracker: TravelTracker, from: number, heights: number[], stepMs = 200) {
  const done = [];
  for (const [i, mm] of heights.entries()) {
    const travel = tracker.report(mm, from + i * stepMs);
    if (travel) {
      done.push(travel);
    }
  }
  return done;
}

test('a journey is timed from its first reported height to its last', () => {
  const tracker = new TravelTracker();
  tracker.report(800, 0);
  // 810 … 1200 over 39 steps of 200 ms: 390 mm in 7.8 s.
  const heights = Array.from({ length: 40 }, (_, i) => 810 + i * 10);
  assert.deepEqual(drive(tracker, 1000, heights), []);

  const lastAt = 1000 + 39 * 200;
  assert.equal(tracker.flush(lastAt + TRAVEL_GAP_MS), null, 'not quiet for long enough yet');
  assert.deepEqual(tracker.flush(lastAt + TRAVEL_GAP_MS + 1), {
    direction: 'up',
    mm: 390,
    seconds: 7.8,
    endedAt: lastAt,
  });
  assert.equal(tracker.flush(lastAt + 10_000), null, 'counted once');
});

test('a pause in the stream or a turn ends the journey before it', () => {
  const tracker = new TravelTracker();
  tracker.report(1000, 0);
  drive(tracker, 100, [980, 960, 940, 920, 900]);

  // Going back up closes the way down.
  const [down] = drive(tracker, 1000, [910]);
  assert.equal(down.direction, 'down');
  assert.equal(down.mm, 80);

  drive(tracker, 1200, [950, 1000]);
  // Heard again after a pause: the part before it is a journey of its own.
  const [up] = drive(tracker, 1400 + TRAVEL_GAP_MS + 1, [1050]);
  assert.deepEqual(up, { direction: 'up', mm: 90, seconds: 0.4, endedAt: 1400 });
});

test('nudges and a resting desk wandering are not journeys', () => {
  const tracker = new TravelTracker();
  tracker.report(1000, 0);
  drive(tracker, 100, [1005, 1010, 1020]);
  assert.equal(tracker.flush(10_000), null, '20 mm is a nudge');

  // One report every half minute, a few millimetres apart.
  for (const [i, mm] of [1022, 1019, 1023].entries()) {
    assert.equal(tracker.report(mm, 40_000 + i * 30_000), null);
  }
  assert.equal(tracker.flush(200_000), null);
});

test('a lost link forgets the journey under way', () => {
  const tracker = new TravelTracker();
  tracker.report(800, 0);
  drive(tracker, 100, [850, 900, 950]);
  tracker.reset();
  assert.equal(tracker.flush(100_000), null);
});
