/**
 * How long the desk spent at sitting and at standing height.
 *
 * Only counted while auto movement is switched on and inside one of its
 * windows: that is the one stretch of time the plugin can be fairly sure
 * somebody is at the desk. A desk left standing overnight is not somebody
 * standing overnight.
 *
 * Kept per local calendar day as two numbers, not as a trace of heights, for
 * the last hundred days. That is all the settings page shows.
 */
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Posture = 'sitting' | 'standing';

/** Seconds at each posture on one day. */
export interface DayTotals {
  sitting: number;
  standing: number;
}

/** What is on disk. Also read by the settings page, which runs separately. */
export interface StatsFile {
  version: 1;
  name: string;
  mac: string;
  /** The height that divides sitting from standing when this was written. */
  thresholdMm: number;
  savedAt: string;
  /** Keyed by local day, as `2026-09-24`. */
  days: Record<string, DayTotals>;
}

/** How many days are kept. The oldest go when a new one starts. */
export const KEEP_DAYS = 100;

/** The spans the settings page shows, in days, today included. */
export const SPANS = [1, 7, 30, 100] as const;

/**
 * Longest gap between two samples that still counts as continuous.
 *
 * Samples come every 30 s. A longer gap means the process was stalled or the
 * machine slept, and nobody knows what the desk did in it.
 */
const MAX_GAP_MS = 120_000;

/** A local calendar day, as `2026-09-24`. Local, because the windows are. */
export function dayKey(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, '0');
  const day = String(when.getDate()).padStart(2, '0');
  return `${when.getFullYear()}-${month}-${day}`;
}

/** Where a desk's statistics live, one file per dongle. */
export function statsPath(storagePath: string, mac: string): string {
  return join(storagePath, `eliot-stats-${mac.replace(/:/g, '').toUpperCase()}.json`);
}

/** Read a statistics file, or null if there is none or it is not one. */
export function readStats(path: string): StatsFile | null {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as StatsFile;
    return data?.version === 1 && data.days && typeof data.days === 'object' ? data : null;
  } catch {
    return null;
  }
}

/**
 * Totals over the last `days` calendar days, today included.
 *
 * Counted back by calendar day rather than by 24-hour blocks, so a daylight
 * saving change does not drop or double a day.
 */
export function totalsFor(days: Record<string, DayTotals>, span: number, now: Date): DayTotals {
  const total = { sitting: 0, standing: 0 };
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let i = 0; i < span; i += 1) {
    const entry = days[dayKey(day)];
    if (entry) {
      total.sitting += entry.sitting;
      total.standing += entry.standing;
    }
    day.setDate(day.getDate() - 1);
  }
  return total;
}

/**
 * How many calendar days the record reaches back, today included.
 *
 * A span longer than this would repeat a shorter one's numbers under a
 * bigger name, so the settings page leaves it out until the record is long
 * enough to fill it. Counted from the first day recorded, not the number of
 * days with data: a weekend without any still belongs to the week.
 */
export function daysRecorded(days: Record<string, DayTotals>, now: Date): number {
  const keys = Object.keys(days).sort();
  if (keys.length === 0) {
    return 0;
  }
  const [y, m, d] = keys[0].split('-').map(Number);
  const first = new Date(y, m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Rounded, because a daylight saving change makes one day 23 or 25 hours.
  return Math.round((today.getTime() - first.getTime()) / 86_400_000) + 1;
}

/** What a sample needs to know about the desk and the schedule. */
export interface Sample {
  /** Auto movement is on and a window is open. */
  counting: boolean;
  /** Null when the desk is not connected, or has not said yet. */
  heightMm: number | null;
}

export class PostureStats {
  readonly #path: string;
  readonly #name: string;
  readonly #mac: string;
  readonly #thresholdMm: number;
  #days: Record<string, DayTotals>;
  /** The last sample that counted, and what it saw. */
  #last: { at: number; posture: Posture } | null = null;
  #dirty = false;
  /** The file's modification time as this process last wrote or read it. */
  #seen: number | null;

  /**
   * @param thresholdMm Heights at or above this are standing. Halfway between
   *   the configured sitting and standing heights: nobody works for long in
   *   between, so where exactly the line falls hardly matters.
   */
  constructor(path: string, name: string, mac: string, thresholdMm: number) {
    this.#path = path;
    this.#name = name;
    this.#mac = mac;
    this.#thresholdMm = thresholdMm;
    this.#days = readStats(path)?.days ?? {};
    this.#seen = mtime(path);
  }

  get days(): Readonly<Record<string, DayTotals>> {
    return this.#days;
  }

  /**
   * Take a sample.
   *
   * The time since the previous sample goes to the posture seen then: a desk
   * that moved in between is credited from the next sample on, which over a
   * day evens out to within a sample or two.
   */
  sample(now: number, input: Sample): void {
    const last = this.#last;
    if (last && now > last.at && now - last.at <= MAX_GAP_MS) {
      this.#add(last.at, now, last.posture);
    }
    this.#last =
      input.counting && input.heightMm !== null
        ? { at: now, posture: input.heightMm >= this.#thresholdMm ? 'standing' : 'sitting' }
        : null;
  }

  /** Credit `from`–`to` to a posture, split at midnight where it crosses one. */
  #add(from: number, to: number, posture: Posture): void {
    let start = from;
    while (start < to) {
      const at = new Date(start);
      const midnight = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1).getTime();
      const end = Math.min(to, midnight);
      const key = dayKey(at);
      const entry = (this.#days[key] ??= { sitting: 0, standing: 0 });
      entry[posture] = Math.round((entry[posture] + (end - start) / 1000) * 10) / 10;
      start = end;
    }
    this.#dirty = true;
  }

  /** Forget days that have fallen out of the hundred kept. */
  #prune(now: Date): void {
    const oldest = dayKey(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - (KEEP_DAYS - 1)),
    );
    for (const key of Object.keys(this.#days)) {
      if (key < oldest) {
        delete this.#days[key];
      }
    }
  }

  /**
   * Write the file if anything was counted since the last write.
   *
   * Written beside and renamed over, so a crash mid-write leaves last time's
   * file rather than half of this one.
   */
  save(now: Date = new Date()): void {
    // The settings page resets the statistics by deleting the file, from a
    // process of its own. Writing what is held here would undo that, so a
    // file that is gone or has changed since this process last touched it
    // wins, and the few minutes counted since the last write go with it.
    const current = mtime(this.#path);
    if (current !== this.#seen) {
      this.#days = readStats(this.#path)?.days ?? {};
      this.#seen = current;
      this.#dirty = false;
      return;
    }
    if (!this.#dirty) {
      return;
    }
    this.#prune(now);
    const data: StatsFile = {
      version: 1,
      name: this.#name,
      mac: this.#mac,
      thresholdMm: this.#thresholdMm,
      savedAt: now.toISOString(),
      days: this.#days,
    };
    const temp = `${this.#path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(temp, this.#path);
    this.#seen = mtime(this.#path);
    this.#dirty = false;
  }
}

/** A file's modification time, or null if there is no file. */
function mtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
