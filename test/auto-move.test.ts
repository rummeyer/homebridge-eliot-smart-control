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

/**
 * Switched on at `when`, which is also when its first interval starts.
 *
 * The moment matters: switching on puts a full interval on the clock there and
 * then, so a mover switched on by the wall clock and then polled at a made-up
 * one has a countdown thirty minutes into next year.
 */
const running = (when: Date = at(9)) => {
  const mover = new AutoMover(OPTIONS);
  mover.setEnabled(true, when);
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
  // Switched on over breakfast, an hour before the working day.
  const mover = running(at(7));
  assert.equal(mover.poll(at(7, 30), 800, false).kind, 'none', 'nothing outside the hours');
  assert.equal(mover.dueAt, null, 'and no countdown to arrive at 08:00 already spent');

  // 08:00 sharp, before anyone has sat down.
  assert.equal(mover.poll(at(8), 800, false).kind, 'none');
  assert.ok(mover.dueAt !== null, 'but the countdown is running now');
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
  const mover2 = running(at(11, 31));
  mover2.poll(at(11, 31), 800, false);
  assert.equal(mover2.poll(at(11, 56), 800, false).kind, 'warn');
  assert.equal(
    mover2.poll(at(12, 1), 800, false).kind,
    'clear',
    'a phone buzzing about a move that will never happen is worse than silence',
  );
});

test('lunch pauses the countdown, and 13:00 carries on where 12:00 left it', () => {
  // Stood up at 11:40: ten minutes of the interval are still to come at noon.
  const mover = running(at(11, 40));
  mover.poll(at(11, 40), 800, false);

  mover.poll(at(12, 0), 800, false);
  assert.equal(mover.dueAt, null, 'nothing is due over lunch');
  assert.equal(mover.remainingPercent(at(12, 30)), 33, 'the slider stands where it stopped');

  mover.poll(at(13, 0), 800, false);
  assert.equal(mover.dueAt, at(13, 10).getTime(), 'the ten minutes, not a fresh thirty');
  assert.equal(mover.poll(at(13, 5), 800, false).kind, 'warn');
  assert.equal(mover.poll(at(13, 10), 800, false).kind, 'move');
});

test('the pause is held from when the window closed, not from the next poll', () => {
  // Due 12:10. The desk was out of reach from 11:58, so the first poll after
  // the window closed comes at 12:20 — after the move would have been due.
  const mover = running(at(11, 40));
  mover.poll(at(11, 40), 800, false);
  mover.poll(at(12, 20), 800, false);

  mover.poll(at(13, 0), 800, false);
  assert.equal(mover.dueAt, at(13, 10).getTime());
});

test('a pause that caught the warning still warns before the move', () => {
  // Due 12:02, warned at 11:57, withdrawn at 12:00 with two minutes left.
  const mover = running(at(11, 32));
  mover.poll(at(11, 32), 800, false);
  assert.equal(mover.poll(at(11, 57), 800, false).kind, 'warn');
  assert.equal(mover.poll(at(12, 0), 800, false).kind, 'clear');

  mover.poll(at(13, 0), 800, false);
  assert.equal(mover.dueAt, at(13, 5).getTime(), 'never closer than the warning');
  assert.equal(mover.poll(at(13, 0), 800, false).kind, 'warn');
});

test('a handset move over lunch gives the afternoon a full interval', () => {
  const mover = running(at(11, 50));
  mover.poll(at(11, 50), 800, false);
  mover.poll(at(12, 0), 800, false);

  mover.noteManualMove(at(12, 30).getTime());
  assert.equal(mover.remainingPercent(at(12, 30)), 100);

  mover.poll(at(13, 0), 800, false);
  assert.equal(mover.dueAt, at(13, 30).getTime());
});

test('overnight is not a pause', () => {
  // Five minutes left at 16:00; the next morning starts afresh.
  const mover = running(at(15, 35));
  mover.poll(at(15, 35), 800, false);
  mover.poll(at(16, 0), 800, false);
  assert.equal(mover.remainingPercent(at(16, 30)), 17, 'held for the rest of the day');

  const tuesday = (hh: number, mm = 0) => new Date(2026, 8, 22, hh, mm, 0);
  assert.equal(mover.remainingPercent(tuesday(7)), 100);
  mover.poll(tuesday(8), 800, false);
  assert.equal(mover.dueAt, tuesday(8, 30).getTime());
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

  mover.setEnabled(false, minutes(start, 29));
  assert.equal(mover.dueAt, null);

  // Back on a minute later: a full interval, not the one second that was left.
  mover.setEnabled(true, minutes(start, 30));
  assert.equal(mover.poll(minutes(start, 31), 800, false).kind, 'none');
  assert.equal(mover.poll(minutes(start, 60), 800, false).kind, 'move', 'thirty minutes later');
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
  assert.equal(mover.poll(at(9, 20), 800, false).kind, 'none');
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

test('the timer reads zero while off, and full the moment it is switched on', () => {
  const mover = new AutoMover(OPTIONS);
  assert.equal(mover.remainingPercent(at(9)), 0, 'off is not a countdown standing still');

  mover.setEnabled(true, at(9));
  assert.equal(mover.remainingPercent(at(9)), 100, 'and on is a full interval, now');

  mover.setEnabled(false, at(9, 10));
  assert.equal(mover.remainingPercent(at(9, 10)), 0, 'back to zero, not to where it stopped');
});

test('the timer runs down with the interval', () => {
  const mover = running(at(9));
  assert.equal(mover.remainingPercent(at(9, 15)), 50);
  assert.equal(mover.remainingPercent(at(9, 27)), 10);
  assert.equal(mover.remainingPercent(at(9, 30)), 0, 'due');
  assert.equal(mover.remainingPercent(at(9, 45)), 0, 'and overdue is not a negative slider');
});

test('outside the hours the timer is full rather than counting down to nothing', () => {
  const mover = running(at(7));
  mover.poll(at(7, 30), 800, false);
  assert.equal(mover.dueAt, null, 'nothing is scheduled');
  assert.equal(mover.remainingPercent(at(7, 30)), 100, 'so it waits at full, and is not empty');
});

test('switched on before the hours, the timer waits full for the window', () => {
  // Switched on over breakfast. Nothing may run down before 08:00, whether or
  // not anybody polls — the desk may be unreachable, and then nobody does.
  const mover = running(at(7));
  assert.equal(mover.dueAt, null, 'no countdown yet');
  assert.equal(mover.remainingPercent(at(7, 45)), 100, 'full, not run down');

  mover.poll(at(8), 800, false);
  assert.equal(mover.dueAt, at(8, 30).getTime(), 'the interval starts with the window');
});

test('outside the hours the timer cannot be dragged or run out', () => {
  const mover = running(at(12, 10));

  mover.setRemainingPercent(20, at(12, 10));
  assert.equal(mover.remainingPercent(at(12, 10)), 100, 'a drag does not stick');

  mover.expire(at(12, 10));
  assert.equal(mover.dueAt, null, 'running it out schedules nothing');
  assert.equal(mover.poll(at(12, 11), 800, false).kind, 'none', 'and nothing moves');

  mover.noteManualMove(at(12, 20).getTime());
  assert.equal(mover.dueAt, null, 'nor does a nudge on the handset start a clock');
});

test('dragging the timer changes the wait and nothing else', () => {
  const mover = running(at(9));
  mover.poll(at(9), 800, false);

  // Twenty minutes in, put back to a full interval.
  mover.setRemainingPercent(100, at(9, 20));
  assert.equal(mover.poll(at(9, 30), 800, false).kind, 'none', 'the old 09:30 is gone');
  assert.equal(mover.poll(at(9, 50), 800, false).kind, 'move', 'due thirty minutes on');
});

test('a drag that lands clear of the warning still warns', () => {
  const mover = running(at(9));
  // Half an interval left: due 09:15, so the warning falls at 09:10.
  mover.setRemainingPercent(50, at(9));
  assert.equal(mover.poll(at(9, 9), 800, false).kind, 'none');
  assert.equal(mover.poll(at(9, 10), 800, false).kind, 'warn');
});

test('a drag into the warning does not warn about what was just asked for', () => {
  const mover = running(at(9));
  // Just under four minutes, which is inside the five-minute warning.
  mover.setRemainingPercent(13, at(9));
  assert.equal(mover.poll(at(9, 1), 800, false).kind, 'none', 'no buzz a minute after the drag');
  assert.equal(mover.poll(at(9, 4), 800, false).kind, 'move', 'it just moves, as asked');
});

test('running the timer out by hand is a move, and not a warning first', () => {
  const mover = running(at(9));
  mover.expire(at(9, 3));

  assert.equal(mover.poll(at(9, 3), 800, false).kind, 'move', 'the next poll takes it');
  assert.equal(mover.remainingPercent(at(9, 3)), 100, 'and the timer is full again at once');
});

test('the timer fills again after a move and after a handset nudge', () => {
  const mover = running(at(9));
  assert.equal(mover.poll(at(9, 30), 800, false).kind, 'move');
  assert.equal(mover.remainingPercent(at(9, 30)), 100);

  mover.noteManualMove(at(9, 40).getTime());
  assert.equal(mover.remainingPercent(at(9, 40)), 100, 'a nudge is a fresh interval too');
});

test('the timer cannot be dragged while auto movement is off', () => {
  const mover = new AutoMover(OPTIONS);

  mover.setRemainingPercent(100, at(9));
  assert.equal(mover.dueAt, null, 'there is no countdown to set');
  assert.equal(mover.remainingPercent(at(9)), 0);

  mover.expire(at(9));
  assert.equal(mover.dueAt, null, 'and none to run out');
});
