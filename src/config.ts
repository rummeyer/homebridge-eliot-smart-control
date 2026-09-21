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
   * Eco mode, and with it the travel speed. Left alone unless set.
   *
   * The control box stores these two together in its settings block, and this
   * plugin writes them as a pair: eco on goes with the slowest travel the app
   * offers, eco off with the fastest. They are not separate knobs here because
   * they are not separate decisions — eco mode is the slow, quiet setting.
   *
   * Neither takes effect when written. The box stores them and goes on running
   * whatever it was reset with, which is why the settings block can report a
   * value the desk is visibly not using. They come into force only when the
   * desk is reset by hand: run it to the bottom and hold the down key until it
   * re-homes. No command on this port can do that, and the plugin does not
   * pretend otherwise — it writes the pair, says so in the log, and leaves the
   * reset to whoever is standing there.
   *
   * Undefined means the desk's own setting is left untouched, which is the
   * default: a plugin that quietly rewrote a stored setting would be arming a
   * change that fires at the next reset, long after anyone connected it to
   * Homebridge.
   */
  ecoMode?: boolean;
  /**
   * Store one-touch mode on the desk. On unless set to false.
   *
   * Everything this plugin offers beyond raise and lower needs the control box
   * to drive to a position by itself: memory switches, a target height, any
   * move the Home app starts and then stops watching. Hold-to-move turns those
   * into a nudge.
   *
   * Like {@link ecoMode} it is stored rather than applied, and takes effect at
   * the desk's next manual reset. It is written even on a desk that is visibly
   * driving itself, because the stored value is what the *next* reset makes
   * live — a box running one-touch while storing hold-to-move is one reset away
   * from silently losing every preset.
   */
  oneTouch?: boolean;
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
  if (desk.ecoMode !== undefined && typeof desk.ecoMode !== 'boolean') {
    problems.push(`${where}.ecoMode must be true or false`);
  }
  if (desk.oneTouch !== undefined && typeof desk.oneTouch !== 'boolean') {
    problems.push(`${where}.oneTouch must be true or false`);
  }
  return problems;
}
