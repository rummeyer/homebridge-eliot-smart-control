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
  /** `"08:00-12:00"` and friends. */
  windows: string[];
  /** Weekdays it runs on, `0` Sunday through `6` Saturday. */
  days: number[];
  /**
   * Switch itself off when the day it was switched on for is over.
   *
   * So that it runs on the days somebody asked for it and not on every day
   * afterwards. Without this the switch is a standing instruction, which is
   * fine for a desk that is used the same way daily and wrong for one that is
   * not — a week away and it has been cycling an empty room for five days.
   */
  switchOffDaily: boolean;
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
  readonly #windows: Window[];

  /** When the next move is due, or null when nothing is scheduled. */
  #dueAt: number | null = null;
  /** Whether the warning for the currently scheduled move has been raised. */
  #warned = false;
  /** Whether the owner has switched this on. Off until told otherwise. */
  #enabled = false;
  /**
   * The day it was switched on for, as `2026-09-21`.
   *
   * A date rather than a timer: a timer set for midnight does not survive a
   * restart, and a desk whose plugin restarted at 23:59 would go on moving the
   * next day. Comparing the day it was switched on against the day it is now
   * gives the same answer however often the plugin stops and starts.
   */
  #enabledDay: string | null = null;

  constructor(options: AutoMoveOptions) {
    this.#opts = options;
    this.#windows = options.windows
      .map(parseWindow)
      .filter((w): w is Window => w !== null);
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /**
   * Turn the whole thing on or off.
   *
   * Switching on starts a full interval. Switching off forgets the countdown
   * rather than pausing it — coming back to a desk that moves the instant it is
   * re-enabled is not what the switch appears to promise, and it is why the
   * timer reads 0 while this is off rather than holding where it stopped.
   */
  setEnabled(on: boolean, now: Date = new Date()): void {
    this.#enabled = on;
    this.#enabledDay = on ? dayKey(now) : null;
    this.#warned = false;
    // Switching on starts the countdown at its full length here rather than
    // leaving it to the next poll. The poll would get there within half a
    // minute either way, and until the timer was on show that was invisible —
    // a slider that reads empty for the first thirty seconds after switching
    // on reads as broken. Outside a window the poll still clears it, so this
    // does not bring back a desk that moves at 08:00 sharp.
    this.#dueAt = on ? now.getTime() + this.#opts.intervalMinutes * MINUTE : null;
  }

  /** The day it was switched on for, so a restart can carry it across. */
  get enabledDay(): string | null {
    return this.#enabledDay;
  }

  /** Restore what a previous run had, without treating it as a fresh switch-on. */
  restore(enabled: boolean, day: string | null): void {
    this.#enabled = enabled;
    this.#enabledDay = enabled ? day : null;
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
   * down towards one.
   */
  remainingPercent(now: Date = new Date()): number {
    if (!this.#enabled) {
      return 0;
    }
    if (this.#dueAt === null) {
      return 100;
    }
    const left = this.#dueAt - now.getTime();
    const full = this.#opts.intervalMinutes * MINUTE;
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
    if (!this.#enabled) {
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
    if (!this.#enabled) {
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
    this.#dueAt = now + this.#opts.intervalMinutes * MINUTE;
    this.#warned = false;
  }

  /** Whether `now` falls inside a configured window on a configured day. */
  #isWorkingTime(now: Date): boolean {
    if (!this.#opts.days.includes(now.getDay())) {
      return false;
    }
    const minutes = now.getHours() * 60 + now.getMinutes();
    return this.#windows.some((w) => minutes >= w.from && minutes < w.to);
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

    // Before anything else: a new day ends it, wherever the countdown had got
    // to and whether or not this is a working day. Checked on every poll rather
    // than at a particular hour, so it holds however long the plugin was down.
    if (this.#enabled && this.#opts.switchOffDaily && this.#enabledDay !== dayKey(now)) {
      this.setEnabled(false, now);
      return { kind: 'off' };
    }

    if (!this.#enabled || !this.#isWorkingTime(now)) {
      // Outside the hours nothing is pending, and any warning is withdrawn —
      // a phone that buzzes at 17:05 about a move that will never happen is
      // worse than one that stays quiet.
      this.#dueAt = null;
      return this.#withdraw();
    }

    if (heightMm === null || busy) {
      return { kind: 'none' };
    }

    if (this.#dueAt === null) {
      // First poll inside a window: start the clock, do not move. Moving the
      // moment a window opens would mean the desk moves at 08:00 sharp every
      // day, before anyone has sat down at it.
      this.#dueAt = ms + this.#opts.intervalMinutes * MINUTE;
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

  /** Clear a standing warning, and say so only if there was one. */
  #withdraw(): AutoMoveAction {
    if (!this.#warned) {
      return { kind: 'none' };
    }
    this.#warned = false;
    return { kind: 'clear' };
  }
}
