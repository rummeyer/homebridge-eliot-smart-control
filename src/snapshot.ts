/**
 * What the desk last said about itself, for the Desk tab of the settings page.
 *
 * The page cannot ask the desk: the dongle takes one connection and this plugin
 * is holding it. So the plugin writes down what the box reports, and the page
 * reads that.
 *
 * Values are kept when the desk goes out of reach, so the page can show them
 * as last seen rather than as nothing. Eco mode and sensitivity are what the
 * box has stored, which it runs only from its next reset on — usually what it
 * is running now, not always.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DeskState } from './eliot/desk.ts';

export type Sensitivity = 'high' | 'medium' | 'low';

/** What is on disk. Also read by the settings page, which runs separately. */
export interface SnapshotFile {
  version: 1;
  name: string;
  mac: string;
  /** When something in here last changed. */
  changedAt: string;
  connected: boolean;
  heightMm: number | null;
  /** Usable travel: the soft limits if set, otherwise the physical range. */
  minMm: number | null;
  maxMm: number | null;
  physicalMinMm: number | null;
  physicalMaxMm: number | null;
  /** The four memory heights, null where unset; null altogether until known. */
  memories: (number | null)[] | null;
  locked: boolean | null;
  ecoMode: 'on' | 'off' | null;
  velocity: number | null;
  sensitivity: Sensitivity | null;
  units: 'cm' | 'inch' | null;
  firmware: number | null;
}

type Values = Omit<SnapshotFile, 'version' | 'name' | 'mac' | 'changedAt'>;

/**
 * A new height counts as a change only this far from the one written down.
 *
 * A resting desk wanders by a few millimetres between reports, and a file
 * rewritten for each of those would be written every half minute for nothing.
 */
const HEIGHT_CHANGE_MM = 5;

/** Where a desk's snapshot lives, one file per dongle. */
export function snapshotPath(storagePath: string, mac: string): string {
  return join(storagePath, `eliot-desk-${mac.replace(/:/g, '').toUpperCase()}.json`);
}

/** Read a snapshot, or null if there is none or it is not one. */
export function readSnapshot(path: string): SnapshotFile | null {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as SnapshotFile;
    return data?.version === 1 && typeof data.mac === 'string' ? data : null;
  } catch {
    return null;
  }
}

/** The box's `1`–`3` in the words the config uses. */
function sensitivityName(value: number | null): Sensitivity | null {
  switch (value) {
    case 1:
      return 'high';
    case 2:
      return 'medium';
    case 3:
      return 'low';
    default:
      return null;
  }
}

const EMPTY: Values = {
  connected: false,
  heightMm: null,
  minMm: null,
  maxMm: null,
  physicalMinMm: null,
  physicalMaxMm: null,
  memories: null,
  locked: null,
  ecoMode: null,
  velocity: null,
  sensitivity: null,
  units: null,
  firmware: null,
};

export class DeskSnapshot {
  readonly #path: string;
  readonly #name: string;
  readonly #mac: string;
  #values: Values;

  /** Starts from the file, so what was known before a restart is not lost. */
  constructor(path: string, name: string, mac: string) {
    this.#path = path;
    this.#name = name;
    this.#mac = mac;
    const known = readSnapshot(path);
    this.#values = { ...EMPTY };
    if (known) {
      for (const key of Object.keys(EMPTY) as (keyof Values)[]) {
        (this.#values as Record<string, unknown>)[key] = known[key] ?? EMPTY[key];
      }
    }
  }

  get values(): Readonly<Values> {
    return this.#values;
  }

  /**
   * Take the desk's state in.
   *
   * @returns Whether anything worth writing down changed. What the desk has
   *   not said stays as it was last seen; the heights and memories only count
   *   once a full refresh has made them trustworthy, and not mid-move.
   */
  update(state: DeskState): boolean {
    const next: Values = { ...this.#values, connected: state.connected };
    const { settings } = state;

    if (state.ready && state.moving === null) {
      if (
        state.heightMm !== null &&
        (next.heightMm === null || Math.abs(state.heightMm - next.heightMm) >= HEIGHT_CHANGE_MM)
      ) {
        next.heightMm = state.heightMm;
      }
      next.minMm = state.minMm;
      next.maxMm = state.maxMm;
      next.physicalMinMm = state.physicalMinMm;
      next.physicalMaxMm = state.physicalMaxMm;
      next.memories = [...state.memories];
    }
    if (state.locked !== null) {
      next.locked = state.locked;
    }
    if (settings.lowPower !== null) {
      next.ecoMode = settings.lowPower ? 'on' : 'off';
    }
    next.velocity = settings.velocity ?? next.velocity;
    next.sensitivity = sensitivityName(settings.sensitivity) ?? next.sensitivity;
    next.units = settings.units ?? next.units;
    next.firmware = settings.firmware ?? next.firmware;

    if (JSON.stringify(next) === JSON.stringify(this.#values)) {
      return false;
    }
    this.#values = next;
    return true;
  }

  /** Mark the desk out of reach, keeping everything else as last seen. */
  disconnect(): boolean {
    if (!this.#values.connected) {
      return false;
    }
    this.#values = { ...this.#values, connected: false };
    return true;
  }

  /**
   * Write the file. Written beside and renamed over, so the page never reads
   * half of one.
   */
  save(now: Date = new Date()): void {
    const data: SnapshotFile = {
      version: 1,
      name: this.#name,
      mac: this.#mac,
      changedAt: now.toISOString(),
      ...this.#values,
    };
    const temp = `${this.#path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(temp, this.#path);
  }
}
