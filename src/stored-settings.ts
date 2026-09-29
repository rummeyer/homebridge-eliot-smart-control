/**
 * What the control box last said it has stored, for the settings page.
 *
 * The page cannot ask the desk: the dongle takes one connection and this plugin
 * is holding it. So the plugin writes down what the box reports on connecting,
 * and the page reads that — which is what "Keep the desk's current setting"
 * would keep.
 *
 * Stored, not running. The box takes a new eco mode or sensitivity at once but
 * goes on running whatever it was last reset with, so these are what it will
 * run after its next reset, and usually what it is running now.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DeskSettings } from './eliot/desk.ts';

export type Sensitivity = 'high' | 'medium' | 'low';

/** What is on disk. Also read by the settings page, which runs separately. */
export interface StoredSettingsFile {
  version: 1;
  name: string;
  mac: string;
  /** When the desk last reported these. */
  readAt: string;
  /** Null where the desk has not said. */
  ecoMode: 'on' | 'off' | null;
  velocity: number | null;
  sensitivity: Sensitivity | null;
}

/** Where a desk's reported settings live, one file per dongle. */
export function storedSettingsPath(storagePath: string, mac: string): string {
  return join(storagePath, `eliot-desk-${mac.replace(/:/g, '').toUpperCase()}.json`);
}

/** Read a settings file, or null if there is none or it is not one. */
export function readStoredSettings(path: string): StoredSettingsFile | null {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as StoredSettingsFile;
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

/**
 * The part of the desk's settings worth writing down, or null while the eco
 * pair has not arrived — a file with nothing in it would only say "unknown"
 * with a timestamp on it.
 */
export function storedFrom(
  settings: DeskSettings,
): Pick<StoredSettingsFile, 'ecoMode' | 'velocity' | 'sensitivity'> | null {
  if (settings.lowPower === null || settings.velocity === null) {
    return null;
  }
  return {
    ecoMode: settings.lowPower ? 'on' : 'off',
    velocity: settings.velocity,
    sensitivity: sensitivityName(settings.sensitivity),
  };
}

/**
 * Write the file. Written beside and renamed over, so the page never reads
 * half of one.
 */
export function writeStoredSettings(path: string, data: StoredSettingsFile): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(temp, path);
}
