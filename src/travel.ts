/**
 * Picks the desk's journeys out of the heights it reports, to time them.
 *
 * The box streams its height several times a second while it moves and says
 * nothing at rest, so a journey is a run of changing heights in one direction:
 * it ends when the stream pauses or the direction turns. Timed from the first
 * height reported on the way to the last, ramp-up and slowing down included,
 * whoever started it — this plugin, a memory key or the handset.
 */

export type Direction = 'up' | 'down';

/** One journey, finished. */
export interface Travel {
  direction: Direction;
  mm: number;
  seconds: number;
  /** When the last height of it arrived, for the day it belongs to. */
  endedAt: number;
}

/**
 * A pause in the stream longer than this ends a journey.
 *
 * The box sends heights several times a second while moving. A brief press on
 * the handset pauses a move for about as long as it is held, and the part
 * after that is timed as a journey of its own rather than counting the pause
 * as travel.
 */
export const TRAVEL_GAP_MS = 1_500;

/**
 * Journeys shorter than this are not counted.
 *
 * A nudge is all ramp and no travel, and the few millimetres a resting desk
 * wanders between reports are not a journey at all. The desk coasts about
 * 13 mm when stopped, so anything that short never got going.
 */
export const MIN_TRAVEL_MM = 30;

interface Run {
  direction: Direction;
  firstMm: number;
  firstAt: number;
  lastMm: number;
  lastAt: number;
}

export class TravelTracker {
  #lastMm: number | null = null;
  #run: Run | null = null;

  /**
   * Take a reported height.
   *
   * @returns The journey this height ended, if it ended one: a height after a
   *   pause, or one going the other way, closes the run before it.
   */
  report(heightMm: number, at: number): Travel | null {
    const previous = this.#lastMm;
    this.#lastMm = heightMm;
    if (previous === null || heightMm === previous) {
      return null;
    }
    const direction: Direction = heightMm > previous ? 'up' : 'down';

    let finished: Travel | null = null;
    const run = this.#run;
    if (run && (at - run.lastAt > TRAVEL_GAP_MS || run.direction !== direction)) {
      finished = close(run);
      this.#run = null;
    }
    if (this.#run) {
      this.#run.lastMm = heightMm;
      this.#run.lastAt = at;
    } else {
      this.#run = { direction, firstMm: heightMm, firstAt: at, lastMm: heightMm, lastAt: at };
    }
    return finished;
  }

  /**
   * Close the run under way if the stream has gone quiet, which is how a
   * journey that nothing follows gets counted at all.
   */
  flush(now: number): Travel | null {
    const run = this.#run;
    if (!run || now - run.lastAt <= TRAVEL_GAP_MS) {
      return null;
    }
    this.#run = null;
    return close(run);
  }

  /** Forget everything, for a link that went away mid-journey. */
  reset(): void {
    this.#lastMm = null;
    this.#run = null;
  }
}

function close(run: Run): Travel | null {
  const mm = Math.abs(run.lastMm - run.firstMm);
  const seconds = (run.lastAt - run.firstAt) / 1000;
  if (mm < MIN_TRAVEL_MM || seconds <= 0) {
    return null;
  }
  return { direction: run.direction, mm, seconds, endedAt: run.lastAt };
}
