import type { PlatformConfig } from 'homebridge';

/** One desk, as configured in Homebridge's config.json. */
export interface DeskConfig {
  /** Display name in HomeKit. */
  name: string;
  /**
   * BLE address of the Smart Dongle, e.g. `E5:11:22:33:44:55`.
   *
   * There is no printed address on some dongles and no vendor name in the
   * advertisement — it appears as `Schreibtisch`. `tools/eliot-probe.js scan`
   * finds it.
   */
  mac: string;
  /**
   * How often to ask an idle desk for its height, in seconds. 0 disables it.
   *
   * The control box streams its height while it drives itself, so this is only
   * for what happens in between: somebody using the handset, or the desk being
   * moved while Homebridge was not connected.
   *
   * Leave it leisurely. `SETTINGS` is a command, and one that arrives while the
   * box is driving to a position cancels the move — at a few hundred
   * milliseconds it turns every move into a ten-millimetre nudge.
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
  /**
   * Expose the desk's child lock as a switch. On by default.
   *
   * The only setting the control box reads back on this connection, so it is
   * the only one that can be shown honestly rather than remembered.
   */
  childLockSwitch?: boolean;
  /**
   * Eco mode, and with it the travel speed.
   *
   * Three values, not two, because "off" and "don't touch it" are different
   * instructions and a checkbox cannot tell them apart. An unticked box would
   * mean both "make this desk fast" and "leave this desk alone", and the plugin
   * would have to guess which.
   *
   * - `leave` — the default. The desk's own setting is not read into anything
   *   and nothing is written. A setting written unasked would arm a change that
   *   fires at the owner's next reset, long after anyone connects the two.
   * - `on` — eco mode with the slowest travel the Eliot app offers.
   * - `off` — no eco mode, at the fastest it offers. Measured here: 22.6 mm/s
   *   against 42.4 mm/s.
   *
   * `true` and `false` are accepted as `on` and `off`, because 1.2.0 shipped
   * this as a boolean.
   *
   * Neither `on` nor `off` takes effect when written. The control box stores
   * the pair and goes on running whatever it was last reset with, so the
   * settings it reports can differ from the speed it is visibly travelling at.
   * They come into force only when the desk is reset by hand: run it to the
   * bottom and hold the down key until it re-homes. No command on this port can
   * do that, and the plugin does not pretend otherwise.
   */
  ecoMode?: 'leave' | 'on' | 'off' | boolean;
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
      `${where}.mac must look like E5:11:22:33:44:55 (got ${JSON.stringify(desk.mac)})`,
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
  if (
    desk.ecoMode !== undefined &&
    typeof desk.ecoMode !== 'boolean' &&
    !['leave', 'on', 'off'].includes(desk.ecoMode)
  ) {
    problems.push(`${where}.ecoMode must be "leave", "on" or "off"`);
  }
  return problems;
}
