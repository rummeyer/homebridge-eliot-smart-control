import assert from 'node:assert/strict';
import test from 'node:test';

import { AutoMover, parseWindow } from '../src/auto-move.ts';

const OPTIONS = {
  sittingMm: 800,
  standingMm: 1200,
  intervalMinutes: 30,
  warnMinutes: 5,
  windows: ['08:00-12:00', '13:00-16:00'],
  // Monday to Friday.
  days: [1, 2, 3, 4, 5],
  switchOffDaily: false,
};

/** A Monday, so the weekday rules apply without saying so every time. */
const at = (hh: number, mm = 0) => new Date(2026, 8, 21, hh, mm, 0);
const minutes = (d: Date, n: number) => new Date(d.getTime() + n * 60_000);

const running = () => {
  const mover = new AutoMover(OPTIONS);
  mover.setEnabled(true);
  return mover;
};

test('a window is parsed, and a backwards one is refused', () => {
  assert.deepEqual(parseWindow('08:00-12:00'), { from: 480, to: 720 });
  assert.deepEqual(parseWindow(' 9:30 - 17:45 '), { from: 570, to: 1065 });
  assert.equal(parseWindow('16:00-08:00'), null, 'more likely a typo than a night shift');
  assert.equal(parseWindow('08:00'), null);
  assert.equal(parseWindow('25:00-26:00'), null);
  assert.equal(parseWindow(''), null);
});

test('nothing happens until it is switched on', () => {
  const mover = new AutoMover(OPTIONS);
  assert.equal(mover.poll(at(9), 800, false).kind, 'none');
  assert.equal(mover.dueAt, null, 'no countdown while off');
});

test('a window opening starts the clock rather than moving the desk', () => {
  const mover = running();
  // 08:00 sharp, before anyone has sat down.
  assert.equal(mover.poll(at(8), 800, false).kind, 'none');
  assert.ok(mover.dueAt !== null, 'but the countdown is running');
});

test('the warning comes first, then the move', () => {
  const mover = running();
  const start = at(9);
  mover.poll(start, 800, false);

  assert.equal(mover.poll(minutes(start, 24), 800, false).kind, 'none');

  const warned = mover.poll(minutes(start, 25), 800, false);
  assert.equal(warned.kind, 'warn');
  assert.equal(warned.kind === 'warn' && warned.inMinutes, 5);

  // Only once, however often it is polled.
  assert.equal(mover.poll(minutes(start, 26), 800, false).kind, 'none');

  const moved = mover.poll(minutes(start, 30), 800, false);
  assert.equal(moved.kind, 'move');
  assert.equal(moved.kind === 'move' && moved.heightMm, 1200, 'sitting, so it stands up');
});

test('the desk heads for whichever height it is further from', () => {
  const mover = running();
  const start = at(9);

  mover.poll(start, 1200, false);
  const fromStanding = mover.poll(minutes(start, 30), 1200, false);
  assert.equal(fromStanding.kind === 'move' && fromStanding.to, 'sitting');

  // Parked between the two, nearer the sitting end.
  const other = running();
  other.poll(start, 900, false);
  const fromMiddle = other.poll(minutes(start, 30), 900, false);
  assert.equal(fromMiddle.kind === 'move' && fromMiddle.to, 'standing');
});

test('a nudge on the handset buys another full interval', () => {
  const mover = running();
  const start = at(9);
  mover.poll(start, 800, false);
  assert.equal(mover.poll(minutes(start, 25), 800, false).kind, 'warn');

  // "I am on a call" — a touch of the handset, one minute before it would move.
  mover.noteManualMove(minutes(start, 29).getTime());

  assert.equal(mover.poll(minutes(start, 30), 810, false).kind, 'none', 'no move');
  // And the warning starts over too, rather than staying raised: the nudge
  // landed at 29, so the move is due at 59 and the warning falls at 54.
  assert.equal(mover.poll(minutes(start, 53), 810, false).kind, 'none');
  assert.equal(mover.poll(minutes(start, 54), 810, false).kind, 'warn');
  assert.equal(mover.poll(minutes(start, 59), 810, false).kind, 'move');
});

test('a move already under way is not interrupted', () => {
  const mover = running();
  const start = at(9);
  mover.poll(start, 800, false);
  assert.equal(mover.poll(minutes(start, 30), 800, true).kind, 'none');
});

test('a height nobody has reported yet is not moved from', () => {
  const mover = running();
  assert.equal(mover.poll(at(9), null, false).kind, 'none');
});

test('outside the windows it stays quiet, and withdraws a warning', () => {
  const mover = running();
  assert.equal(mover.poll(at(12, 30), 800, false).kind, 'none', 'lunch');
  assert.equal(mover.poll(at(17), 800, false).kind, 'none', 'evening');

  // Warned at 11:56, and then the window closes before the move is due.
  const mover2 = running();
  mover2.poll(at(11, 31), 800, false);
  assert.equal(mover2.poll(at(11, 56), 800, false).kind, 'warn');
  assert.equal(
    mover2.poll(at(12, 1), 800, false).kind,
    'clear',
    'a phone buzzing about a move that will never happen is worse than silence',
  );
});

test('the weekend is left alone', () => {
  const mover = running();
  const saturday = new Date(2026, 8, 26, 9, 0, 0);
  assert.equal(saturday.getDay(), 6);
  assert.equal(mover.poll(saturday, 800, false).kind, 'none');
});

test('switching off forgets the countdown instead of pausing it', () => {
  const mover = running();
  const start = at(9);
  mover.poll(start, 800, false);
  mover.poll(minutes(start, 29), 800, false);

  mover.setEnabled(false);
  assert.equal(mover.dueAt, null);

  // Back on a minute later: a full interval, not the one second that was left.
  mover.setEnabled(true);
  mover.poll(minutes(start, 30), 800, false);
  assert.equal(mover.poll(minutes(start, 31), 800, false).kind, 'none');
});

test('a manual move while switched off changes nothing', () => {
  const mover = new AutoMover(OPTIONS);
  mover.noteManualMove(at(9).getTime());
  assert.equal(mover.dueAt, null);
});

test('with the daily switch-off, a new day turns it off', () => {
  const mover = new AutoMover({ ...OPTIONS, switchOffDaily: true });
  mover.setEnabled(true, at(9));
  assert.equal(mover.enabled, true);

  // Later the same day it carries on.
  assert.equal(mover.poll(at(9, 30), 800, false).kind, 'none');
  assert.equal(mover.enabled, true);

  // Tuesday. It does not matter that this is also a working day.
  const tuesday = new Date(2026, 8, 22, 9, 0, 0);
  assert.equal(mover.poll(tuesday, 800, false).kind, 'off');
  assert.equal(mover.enabled, false, 'somebody has to ask for it again');
});

test('without it, the switch stays on across days', () => {
  const mover = new AutoMover(OPTIONS);
  mover.setEnabled(true, at(9));

  const tuesday = new Date(2026, 8, 22, 9, 0, 0);
  mover.poll(tuesday, 800, false);
  assert.equal(mover.enabled, true, 'the default is a standing instruction');
});

test('a restart in the evening does not hand it a fresh day', () => {
  // What the accessory does on startup: restore the switch and the day it was
  // switched on for. Treating that as a switch-on would make "off for the new
  // day" last only until the next time Homebridge came up.
  const mover = new AutoMover({ ...OPTIONS, switchOffDaily: true });
  mover.restore(true, '2026-09-21');

  assert.equal(mover.poll(at(23, 30), 800, false).kind, 'none', 'still Monday');

  const tuesday = new Date(2026, 8, 22, 8, 30, 0);
  assert.equal(mover.poll(tuesday, 800, false).kind, 'off');
});

test('switching off by hand forgets the day too', () => {
  const mover = new AutoMover({ ...OPTIONS, switchOffDaily: true });
  mover.setEnabled(true, at(9));
  mover.setEnabled(false, at(10));
  assert.equal(mover.enabledDay, null);
});
