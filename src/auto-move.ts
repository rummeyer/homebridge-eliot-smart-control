/**
 * When to move the desk on its own, and where to.
 *
 * Kept apart from the desk and from HomeKit because it is the part with the
 * awkward rules — windows, weekdays, a countdown that anybody can reset by
 * touching the handset — and none of that needs Bluetooth or a clock it does
 * not control. Everything here takes `now` as an argument, so a test can run a
 * working day in a millisecond.
 */

/** A stretch of the day, as minutes from midnight. */
interface Window {
  from: number;
  to: number;
}

export interface AutoMoveOptions {
  /** Where "sitting" is, in millimetres. */
  sittingMm: number;
  /** Where "standing" is, in millimetres. */
  standingMm: number;
  /** How long to stay at a height before moving to the other one. */
  intervalMinutes: number;
  /** How long before a move to raise the warning. */
  warnMinutes: number;
  /** `"08:00-12:00"` and friends. None at all means any time, any day. */
  windows: string[];
  /** Weekdays it runs on, `0` Sunday through `6` Saturday. Only with windows. */
  days: number[];
  /**
   * Switch itself off when the day it was switched on for is over.
   *
   * So that it runs on the days somebody asked for it and not on every day
   * afterwards. Without this the switch is a standing instruction, which is
   * fine for a desk that is used the same way daily and wrong for one that is
   * not — a week away and it has been cycling an empty room for five days.
   *
   * The day is over when its last window closes, or at midnight on a day
   * without one — which, with no windows configured, is every day.
   */
  switchOffDaily: boolean;
  /**
   * Where to leave the desk when the day's last window closes, if anywhere.
   *
   * So the desk is where its owner wants it the next morning — standing, to
   * start the day on their feet, or sitting, out of the way — without a last
   * trip to the handset.
   */
  endOfDay: 'standing' | 'sitting' | 'nothing';
}

/**
 * What the caller should do about it, decided once per poll.
 *
 * `clear` is not the absence of `warn`: the sensor has to be told to go quiet
 * again, and the move is not the only thing that ends a warning — a handset
 * nudge or the end of a window does too.
 */
export type AutoMoveAction =
  | { kind: 'none' }
  /** Switched itself off for the day; the switch in HomeKit must follow. */
  | { kind: 'off' }
  | { kind: 'warn'; inMinutes: number }
  | { kind: 'clear' }
  | { kind: 'move'; heightMm: number; to: 'sitting' | 'standing' };

const MINUTE = 60_000;

/**
 * How long after the last window closes the end-of-day move may still happen.
 *
 * The desk may be out of reach at the moment the window closes, and a move a
 * few minutes late is still the one that was asked for. A move at eight in the
 * evening, when the dongle comes back after an outage, is not.
 */
const END_OF_DAY_GRACE_MS = 15 * MINUTE;

/** A desk this close to the end-of-day height is already there. */
const END_OF_DAY_TOLERANCE_MM = 10;

/** Local midnight at the start of the day `when` falls on. */
function midnightOf(when: Date): number {
  return new Date(when.getFullYear(), when.getMonth(), when.getDate()).getTime();
}

/** A local calendar day, as `2026-09-21`. Local, because the windows are. */
function dayKey(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, '0');
  const day = String(when.getDate()).padStart(2, '0');
  return `${when.getFullYear()}-${month}-${day}`;
}

/**
 * Parse `"08:00-12:00"`.
 *
 * Returns null rather than throwing, because this runs over whatever is in
 * somebody's config file and the caller turns that into a readable complaint.
 */
export function parseWindow(text: string): Window | null {
  const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) {
    return null;
  }
  const [fromH, fromM, toH, toM] = match.slice(1).map(Number);
  if (fromH > 23 || toH > 23 || fromM > 59 || toM > 59) {
    return null;
  }
  const from = fromH * 60 + fromM;
  const to = toH * 60 + toM;
  // A window that ends before it starts would have to wrap midnight, and
  // "16:00-08:00" is far more likely to be a typo than a night shift.
  return to > from ? { from, to } : null;
}

export class AutoMover {
  readonly #opts: AutoMoveOptions;
  /** The working hours. Empty means there are none: any time is working time. */
  readonly #windows: Window[];

  /** When the next move is due, or null when nothing is scheduled. */
  #dueAt: number | null = null;
  /**
   * What was left of the countdown when a window closed, and on which day.
   *
   * A gap between two windows — lunch, from 12 to 13 — pauses the countdown
   * rather than throwing it away: somebody who stood up at 11:50 has not been
   * standing for a fresh thirty minutes at 13:00, they have ten to go. Only
   * within a day, though. Overnight is not a pause, and the next morning starts
   * with a full interval like any first window.
   */
  #held: { ms: number; day: string } | null = null;
  /** Whether the warning for the currently scheduled move has been raised. */
  #warned = false;
  /** The day the end-of-day move was made or found unnecessary. */
  #endOfDayDone: string | null = null;
  /** Whether the owner has switched this on. Off until told otherwise. */
  #enabled = false;
  /**
   * When it was switched on, as a time.
   *
   * A time rather than a timer: a timer set for the end of the day does not
   * survive a restart, and a desk whose plugin restarted at 23:59 would go on
   * moving the next day. Working out when that day ended from the moment it
   * was switched on gives the same answer however often the plugin stops and
   * starts.
   */
  #enabledAt: number | null = null;

  constructor(options: AutoMoveOptions) {
    this.#opts = options;
    this.#windows = options.windows
      .map(parseWindow)
      .filter((w): w is Window => w !== null);
  }

  /** Whether working hours are configured, or it may move at any time. */
  get #anyTime(): boolean {
    return this.#windows.length === 0;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /**
   * Turn the whole thing on or off.
   *
   * Switching on inside a window starts a full interval; outside one it starts
   * nothing, and the first poll inside a window does. Switching off forgets the countdown
   * rather than pausing it — coming back to a desk that moves the instant it is
   * re-enabled is not what the switch appears to promise, and it is why the
   * timer reads 0 while this is off rather than holding where it stopped.
   */
  setEnabled(on: boolean, now: Date = new Date()): void {
    this.#enabled = on;
    this.#enabledAt = on ? now.getTime() : null;
    this.#warned = false;
    this.#held = null;
    // Switching on starts the countdown at its full length here rather than
    // leaving it to the next poll: a slider that reads empty for the first
    // thirty seconds after switching on reads as broken. Only inside a window,
    // though. Outside one the slider would run down until the next poll
    // cleared it — or for as long as the desk is unreachable, when there is no
    // poll — and a countdown that visibly runs out at 07:30 and then does
    // nothing looks like a promise broken rather than kept.
    this.#dueAt =
      on && this.inWorkingTime(now) ? now.getTime() + this.#opts.intervalMinutes * MINUTE : null;
  }

  /** When it was switched on, so a restart can carry it across. */
  get enabledAt(): number | null {
    return this.#enabledAt;
  }

  /** Restore what a previous run had, without treating it as a fresh switch-on. */
  restore(enabled: boolean, at: number | null): void {
    this.#enabled = enabled;
    this.#enabledAt = enabled ? at : null;
  }

  /** When the next move is due, for the log and for tests. */
  get dueAt(): number | null {
    return this.#dueAt;
  }

  /**
   * How much of the interval is left, as the timer slider shows it.
   *
   * 0 when auto movement is off. The slider *is* the countdown, and there is no
   * countdown — showing a remainder for a timer that is not running would be
   * showing a number that means nothing.
   *
   * 100 when it is on but nothing is scheduled, which is what being outside the
   * working hours looks like: full, and waiting for a window rather than running
   * down towards one. In a gap between two windows it is whatever was left when
   * the first one closed, standing still until the next one opens.
   */
  remainingPercent(now: Date = new Date()): number {
    if (!this.#enabled) {
      return 0;
    }
    const full = this.#opts.intervalMinutes * MINUTE;
    if (this.#dueAt === null) {
      const held = this.#heldFor(now);
      return held === null ? 100 : Math.min(Math.round((held / full) * 100), 100);
    }
    const left = this.#dueAt - now.getTime();
    return Math.min(Math.max(Math.round((left / full) * 100), 0), 100);
  }

  /**
   * Move the countdown to a point, as a percentage of a full interval.
   *
   * This is somebody dragging the timer slider: 100 is a fresh interval, 50 is
   * half of one left. It changes the wait and nothing else — not where the desk
   * is headed, not whether auto movement is on.
   *
   * Whether the warning still fires depends on where the drag landed. Setting
   * the timer below the warning is already the decision the warning exists to
   * announce, and a phone that buzzes "moving in 4 minutes" the instant somebody
   * asked for four more minutes is noise. Land above it and the warning comes as
   * it always did, at the usual distance from the move.
   */
  setRemainingPercent(percent: number, now: Date = new Date()): void {
    if (!this.#enabled || !this.inWorkingTime(now)) {
      return;
    }
    const clamped = Math.min(Math.max(percent, 0), 100);
    const left = (clamped / 100) * this.#opts.intervalMinutes * MINUTE;
    this.#dueAt = now.getTime() + left;
    this.#warned = left <= this.#opts.warnMinutes * MINUTE;
  }

  /**
   * Treat the countdown as run out, now.
   *
   * The next poll then returns a move, through the same path a move that came
   * due on its own takes — the height it picks and the limits it respects are
   * not this method's business. No warning goes with it: a warning announces a
   * move that is coming, and this one is already here because somebody asked
   * for it.
   */
  expire(now: Date = new Date()): void {
    if (!this.#enabled || !this.inWorkingTime(now)) {
      return;
    }
    this.#dueAt = now.getTime();
    this.#warned = true;
  }

  /**
   * Somebody moved the desk themselves: start the interval again.
   *
   * This is the snooze. The warning says the desk is about to move, and a nudge
   * on the handset buys another full interval without anyone opening an app.
   * It is also simply true: the point of the timer is time spent at a height,
   * and the clock on that restarts whenever the height does.
   */
  noteManualMove(now: number): void {
    if (!this.#enabled) {
      return;
    }
    if (!this.inWorkingTime(new Date(now))) {
      // Moved over lunch: the height changed, so the time held for it is gone,
      // and the next window starts a full interval.
      this.#held = null;
      return;
    }
    this.#dueAt = now + this.#opts.intervalMinutes * MINUTE;
    this.#warned = false;
  }

  /**
   * Whether `now` falls inside a configured window on a configured day.
   *
   * Outside one there is no countdown, and nothing that would start one — a
   * switch-on, a drag of the slider, a nudge on the handset — does. The first
   * poll inside a window starts it. With no windows configured it is always
   * working time, whatever the day: the days only say which days the windows
   * apply to.
   */
  inWorkingTime(now: Date = new Date()): boolean {
    if (this.#anyTime) {
      return true;
    }
    if (!this.#opts.days.includes(now.getDay())) {
      return false;
    }
    const minutes = now.getHours() * 60 + now.getMinutes();
    return this.#windows.some((w) => minutes >= w.from && minutes < w.to);
  }

  /**
   * When the window that last closed today closed, as a time.
   *
   * The countdown is held as it stood at that moment, not at the first poll
   * after it: with the desk out of reach at 12:00 there is no poll until it is
   * back, and the countdown would otherwise have run on into the lunch break.
   * Null before the first window of the day, when there is nothing to hold.
   */
  #lastClose(now: Date): number | null {
    const minutes = now.getHours() * 60 + now.getMinutes();
    const closed = this.#windows.filter((w) => w.to <= minutes).map((w) => w.to);
    if (closed.length === 0) {
      return null;
    }
    return midnightOf(now) + Math.max(...closed) * MINUTE;
  }

  /**
   * When the working day `day` falls on ends, as a time.
   *
   * At its last window's close on a configured day; null on any other day,
   * and every day when there are no windows — there is no close to speak of.
   */
  #closeOn(day: Date): number | null {
    if (this.#anyTime || !this.#opts.days.includes(day.getDay())) {
      return null;
    }
    return midnightOf(day) + Math.max(...this.#windows.map((w) => w.to)) * MINUTE;
  }

  /**
   * When the day it was switched on for is over, for the daily switch-off.
   *
   * At the close of that day's working hours if it was switched on before
   * them, and otherwise at the midnight that ends it: switched on at 17:00,
   * after the close, it has not had its day yet, and should not lose it on the
   * next poll.
   */
  #dayOverAt(enabledAt: number): number {
    const day = new Date(enabledAt);
    const close = this.#closeOn(day);
    if (close !== null && enabledAt < close) {
      return close;
    }
    return new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  }

  /**
   * Whether the end-of-day move is still owed at `now`.
   *
   * The daily switch-off waits for it: turning off at the close would leave
   * the move that belongs to the close undone.
   */
  #endOfDayOwed(now: Date): boolean {
    const close = this.#closeOn(now);
    return (
      this.#opts.endOfDay !== 'nothing' &&
      close !== null &&
      this.#endOfDayDone !== dayKey(now) &&
      now.getTime() < close + END_OF_DAY_GRACE_MS
    );
  }

  /** What is held for today, if anything. */
  #heldFor(now: Date): number | null {
    return this.#held !== null && this.#held.day === dayKey(now) ? this.#held.ms : null;
  }

  /**
   * The height to head for from where the desk is now.
   *
   * Whichever of the two it is further from, so a desk parked anywhere — half
   * way, or at some height somebody liked — still alternates sensibly instead
   * of needing to be at one of the two to know what "the other one" means.
   */
  #targetFrom(heightMm: number): { heightMm: number; to: 'sitting' | 'standing' } {
    const toSitting = Math.abs(heightMm - this.#opts.sittingMm);
    const toStanding = Math.abs(heightMm - this.#opts.standingMm);
    return toSitting < toStanding
      ? { heightMm: this.#opts.standingMm, to: 'standing' }
      : { heightMm: this.#opts.sittingMm, to: 'sitting' };
  }

  /**
   * Decide what to do, now.
   *
   * Called on a timer by whoever owns the desk. `busy` covers a move already
   * running, ours or the handset's: starting a second one would fight it.
   */
  poll(now: Date, heightMm: number | null, busy: boolean): AutoMoveAction {
    const ms = now.getTime();

    // Before anything else: the end of the day ends it, wherever the countdown
    // had got to — once the end-of-day move, if one is owed, has been made.
    // Checked on every poll rather than at a particular hour, so it holds
    // however long the plugin was down. Without a switch-on time to go by —
    // restored from a version that did not keep one — the day is over now.
    if (
      this.#enabled &&
      this.#opts.switchOffDaily &&
      ms >= this.#dayOverAt(this.#enabledAt ?? 0) &&
      !this.#endOfDayOwed(now)
    ) {
      this.setEnabled(false, now);
      return { kind: 'off' };
    }

    if (!this.#enabled || !this.inWorkingTime(now)) {
      // Outside the hours nothing is pending, and any warning is withdrawn —
      // a phone that buzzes at 17:05 about a move that will never happen is
      // worse than one that stays quiet. What was left is held, in case another
      // window opens today.
      const closed = this.#lastClose(now);
      if (this.#enabled && this.#dueAt !== null && closed !== null) {
        this.#held = { ms: Math.max(this.#dueAt - closed, 0), day: dayKey(now) };
      }
      this.#dueAt = null;
      const withdrawn = this.#withdraw();
      if (withdrawn.kind !== 'none') {
        return withdrawn;
      }
      return this.#endOfDay(now, heightMm, busy);
    }

    if (heightMm === null || busy) {
      return { kind: 'none' };
    }

    if (this.#dueAt === null) {
      // First poll inside a window: start the clock, do not move. Moving the
      // moment a window opens would mean the desk moves at 08:00 sharp every
      // day, before anyone has sat down at it.
      //
      // After a gap earlier the same day, the clock picks up where it stopped —
      // but never closer to the move than the warning, which was withdrawn when
      // the window closed and is owed again before anything moves.
      const held = this.#heldFor(now);
      this.#held = null;
      this.#dueAt =
        held === null
          ? ms + this.#opts.intervalMinutes * MINUTE
          : ms + Math.max(held, this.#opts.warnMinutes * MINUTE);
      return this.#withdraw();
    }

    if (ms >= this.#dueAt) {
      const target = this.#targetFrom(heightMm);
      this.#dueAt = ms + this.#opts.intervalMinutes * MINUTE;
      this.#warned = false;
      return { kind: 'move', ...target };
    }

    const warnAt = this.#dueAt - this.#opts.warnMinutes * MINUTE;
    if (ms >= warnAt && !this.#warned) {
      this.#warned = true;
      return { kind: 'warn', inMinutes: Math.round((this.#dueAt - ms) / MINUTE) };
    }

    return { kind: 'none' };
  }

  /**
   * The one move after the day's last window, if one is configured.
   *
   * Only on a working day, only with auto movement on, only once, and only
   * shortly after the last window closes — not after lunch, which is a gap
   * between windows, and not hours later when the desk comes back into reach.
   * A desk already at the height is left alone. Without working hours the day
   * never closes, so this never comes: the close would be midnight, and
   * nobody wants the desk to move at midnight.
   */
  #endOfDay(now: Date, heightMm: number | null, busy: boolean): AutoMoveAction {
    const want = this.#opts.endOfDay;
    const today = dayKey(now);
    const end = this.#closeOn(now);
    if (want === 'nothing' || !this.#enabled || this.#endOfDayDone === today || end === null) {
      return { kind: 'none' };
    }
    const ms = now.getTime();
    if (ms < end || ms >= end + END_OF_DAY_GRACE_MS) {
      return { kind: 'none' };
    }
    if (heightMm === null || busy) {
      return { kind: 'none' };
    }
    this.#endOfDayDone = today;
    const target = want === 'standing' ? this.#opts.standingMm : this.#opts.sittingMm;
    if (Math.abs(heightMm - target) <= END_OF_DAY_TOLERANCE_MM) {
      return { kind: 'none' };
    }
    return { kind: 'move', heightMm: target, to: want };
  }

  /** Clear a standing warning, and say so only if there was one. */
  #withdraw(): AutoMoveAction {
    if (!this.#warned) {
      return { kind: 'none' };
    }
    this.#warned = false;
    return { kind: 'clear' };
  }
}
