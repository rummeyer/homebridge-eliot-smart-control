/**
 * The closed loop that drives the desk to a height.
 *
 * The control box has no "move to X" command — only step-up, step-down and the
 * four memory positions. Continuous movement is the handset repeating a step
 * command about twice a second, and the desk stops when the repeats stop. So
 * the responsibility for stopping is ours, and this is where it lives.
 *
 * Deliberately free of Bluetooth and of timers: it is fed a clock and height
 * reports, and answers with what to send. That makes every stopping condition
 * testable without hardware, which matters more here than anywhere else in the
 * plugin — the failure mode is a desk that keeps driving.
 */

/** Which step command to repeat. */
export type Direction = 'up' | 'down';

/** Why a move ended. Only `arrived` is success. */
export type MoveResult =
  /** Within tolerance of the target. */
  | 'arrived'
  /** Height stopped changing while we were still asking it to move. */
  | 'stalled'
  /** Took longer than the distance can account for. */
  | 'timeout'
  /** Height reports dried up; we no longer know where the desk is. */
  | 'lost';

/** What the caller should do right now. */
export interface MoveStep {
  /** Command to send, or null to send nothing this tick. */
  send: Direction | null;
  /** Non-null once the move is over; the caller then stops calling. */
  result: MoveResult | null;
}

export interface MoveOptions {
  /**
   * How often to repeat the step command. The handset uses about 500 ms; much
   * slower and the desk stops between pulses, much faster is pointless.
   */
  pulseMs: number;
  /**
   * Stop pulsing this far before the target. The desk coasts after the last
   * step, so aiming exactly at the target overshoots it.
   */
  approachMm: number;
  /** Close enough to call it arrived without moving at all. */
  toleranceMm: number;
  /** Progress means moving at least this far… */
  stallMm: number;
  /**
   * …within this long, otherwise something is in the way.
   *
   * Must stay above `reportTimeoutMs`. A desk that has gone silent looks
   * exactly like a desk that is not moving, and the two want opposite
   * responses: silence means we no longer know where it is, which is the more
   * urgent of the two. Ordering the thresholds this way is what keeps a lost
   * link from being misreported as an obstruction.
   */
  stallMs: number;
  /** Give up if no height report arrives for this long. */
  reportTimeoutMs: number;
  /**
   * Slowest travel we will believe, for working out the deadline. Eliot desks
   * manage roughly 25–38 mm/s; this is well under that so a slow desk is not
   * cut off, while a desk going nowhere still hits the limit.
   */
  minSpeedMmPerSecond: number;
  /** Added to the computed deadline, covering start-up lag and coasting. */
  deadlineSlackMs: number;
}

export const DEFAULT_MOVE_OPTIONS: MoveOptions = {
  pulseMs: 400,
  approachMm: 12,
  toleranceMm: 6,
  stallMm: 3,
  stallMs: 3000,
  reportTimeoutMs: 2000,
  minSpeedMmPerSecond: 8,
  deadlineSlackMs: 6000,
};

export class MoveController {
  readonly target: number;
  readonly direction: Direction;
  readonly deadline: number;

  readonly #opts: MoveOptions;
  #height: number;
  #lastReportAt: number;
  #lastPulseAt = Number.NEGATIVE_INFINITY;
  #progressHeight: number;
  #progressAt: number;
  #finished: MoveResult | null = null;

  constructor(
    targetMm: number,
    currentMm: number,
    now: number,
    options: Partial<MoveOptions> = {},
  ) {
    this.#opts = { ...DEFAULT_MOVE_OPTIONS, ...options };
    this.target = targetMm;
    this.direction = targetMm >= currentMm ? 'up' : 'down';
    this.#height = currentMm;
    this.#lastReportAt = now;
    this.#progressHeight = currentMm;
    this.#progressAt = now;

    const distance = Math.abs(targetMm - currentMm);
    this.deadline =
      now + (distance / this.#opts.minSpeedMmPerSecond) * 1000 + this.#opts.deadlineSlackMs;

    // A target we are already sitting on is not a move at all. Deciding this
    // up front keeps the caller from sending a single stray step command.
    if (distance <= this.#opts.toleranceMm) {
      this.#finished = 'arrived';
    }
  }

  /** The last height we were told about. */
  get height(): number {
    return this.#height;
  }

  /** Feed a height report as it arrives. */
  report(heightMm: number, now: number): void {
    this.#height = heightMm;
    this.#lastReportAt = now;

    if (Math.abs(heightMm - this.#progressHeight) >= this.#opts.stallMm) {
      this.#progressHeight = heightMm;
      this.#progressAt = now;
    }
  }

  /** Ask what to do. Call this at least as often as `pulseMs`. */
  step(now: number): MoveStep {
    if (this.#finished) {
      return { send: null, result: this.#finished };
    }

    // Arrival first: a desk that has got there should never be sent another
    // step, whatever else is true of the clock.
    if (this.#reached()) {
      return this.#finish('arrived');
    }
    if (now - this.#lastReportAt > this.#opts.reportTimeoutMs) {
      return this.#finish('lost');
    }
    if (now > this.deadline) {
      return this.#finish('timeout');
    }
    if (now - this.#progressAt > this.#opts.stallMs) {
      return this.#finish('stalled');
    }

    if (now - this.#lastPulseAt >= this.#opts.pulseMs) {
      this.#lastPulseAt = now;
      return { send: this.direction, result: null };
    }
    return { send: null, result: null };
  }

  /** True once the desk is at, or has passed, the point where we stop pulsing. */
  #reached(): boolean {
    const stopAt =
      this.direction === 'up'
        ? this.target - this.#opts.approachMm
        : this.target + this.#opts.approachMm;
    return this.direction === 'up' ? this.#height >= stopAt : this.#height <= stopAt;
  }

  #finish(result: MoveResult): MoveStep {
    this.#finished = result;
    return { send: null, result };
  }
}

/**
 * Map a height to the 0–100 HomeKit uses, against the desk's own soft limits.
 *
 * The limits are what the desk is configured to allow, not what it can
 * physically do, so 0% is the minimum height someone set on the handset. A desk
 * with no limits set reports its physical range instead, and the same maths
 * applies.
 */
export function heightToPercent(heightMm: number, minMm: number, maxMm: number): number {
  if (maxMm <= minMm) {
    return 0;
  }
  const clamped = Math.min(Math.max(heightMm, minMm), maxMm);
  return Math.round(((clamped - minMm) / (maxMm - minMm)) * 100);
}

/** The inverse, for turning a HomeKit target into a height to drive to. */
export function percentToHeight(percent: number, minMm: number, maxMm: number): number {
  const clamped = Math.min(Math.max(percent, 0), 100);
  return Math.round(minMm + ((maxMm - minMm) * clamped) / 100);
}
