import type { PlatformConfig } from 'homebridge';

/** One desk, as configured in Homebridge's config.json. */
export interface DeskConfig {
  /** Display name in HomeKit. */
  name: string;
  /**
   * BLE address of the Smart Dongle, e.g. `E5:02:4F:BF:74:A2`.
   *
   * There is no printed address on some dongles and no vendor name in the
   * advertisement — it appears as `Schreibtisch`. `tools/eliot-probe.js scan`
   * finds it.
   */
  mac: string;
  /**
   * How often to ask an idle desk for its height, in seconds. 0 disables it.
   *
   * The control box reports height by itself while moving, so this only
   * catches what happens in between: somebody using the handset, or the desk
   * being moved while Homebridge was not connected.
   */
  idlePollSeconds?: number;
  /**
   * Expose the desk's memory positions as switches. On by default.
   *
   * Only positions the desk actually has are exposed — an unset memory reads
   * as zero and is skipped.
   */
  memorySwitches?: boolean;
  /**
   * What to call each memory switch in the Home app, in order.
   *
   * Defaults to "<desk> Memory 1" and so on, matching the numbering on the
   * handset. Give as many as you care to name; the rest fall back.
   */
  memoryNames?: string[];
}

export interface EliotPlatformConfig extends PlatformConfig {
  /** Homebridge uses this as the log prefix for everything this plugin says. */
  name?: string;
  desks?: DeskConfig[];
}

/**
 * Validate one configured desk.
 *
 * @returns A list of human-readable problems; empty means the entry is usable.
 */
export function validateDeskConfig(desk: Partial<DeskConfig>, index: number): string[] {
  const problems: string[] = [];
  const where = `desks[${index}]`;

  if (!desk.name?.trim()) {
    problems.push(`${where}.name is required`);
  }
  if (!desk.mac || !/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(desk.mac)) {
    problems.push(
      `${where}.mac must look like E5:02:4F:BF:74:A2 (got ${JSON.stringify(desk.mac)})`,
    );
  }
  if (desk.memoryNames !== undefined && !Array.isArray(desk.memoryNames)) {
    problems.push(`${where}.memoryNames must be a list of names`);
  }
  if (
    desk.idlePollSeconds !== undefined &&
    (!Number.isFinite(desk.idlePollSeconds) || desk.idlePollSeconds < 0)
  ) {
    problems.push(`${where}.idlePollSeconds must be zero or a positive number`);
  }
  return problems;
}
