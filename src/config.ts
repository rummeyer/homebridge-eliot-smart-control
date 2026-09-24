import type { PlatformConfig } from 'homebridge';

import { parseWindow } from './auto-move.ts';

/** One desk, as configured in Homebridge's config.json. */
export interface DeskConfig {
  /** Display name in HomeKit. */
  name: string;
  /**
   * BLE address of the Smart Dongle, e.g. `E5:11:22:33:44:55`.
   *
   * There is no printed address on some dongles and no vendor name in the
   * advertisement; the name it does carry is whatever the desk was called in
   * the Eliot app. `tools/eliot-probe.js scan` finds it by its service UUID.
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
   * - `on` — eco mode, at travel speed 20. Slower than the 28 the app offers at
   *   its slow end: the app's range is not the box's, and a desk found storing
   *   21 took 21 back without complaint.
   * - `off` — no eco mode, at 40, the fastest the app offers. Measured on this
   *   hardware: 22.6 mm/s at speed 21 against 42.4 mm/s at 40.
   *
   * `true` and `false` are accepted as `on` and `off`, because 1.2.0 shipped
   * this as a boolean.
   *
   * Neither `on` nor `off` takes effect when written. The control box stores
   * the pair and goes on running whatever it was last reset with, so the
   * settings it reports can differ from the speed it is visibly travelling at.
   * They come into force only with a reset, so after a write the plugin puts the
   * box into reset mode and the owner finishes it by turning the handset left.
   *
   * Ignored while {@link turbo} is on.
   */
  ecoMode?: 'leave' | 'on' | 'off' | boolean;
  /**
   * No eco mode, at travel speed 60, in place of whatever {@link ecoMode} says.
   *
   * Above anything the app offers, and not in the settings page on purpose: it
   * has to be typed into config.json by hand. The box accepts any speed up to
   * 255; 45, 50 and 55 were measured running cleanly at 48, 54 and 60 mm/s, and
   * 255 made the motor stutter. 60 itself has not been measured. Absent or
   * false leaves {@link ecoMode} in charge, as before. Takes effect after a
   * reset, like eco mode.
   */
  turbo?: boolean;
  /**
   * The control box's own anti-collision sensitivity. Left alone unless set.
   *
   * Not the plugin's stall detection — this is the box deciding for itself
   * that something is in the way and stopping. On `high` a pair of forearms
   * resting on the desk is enough, which ends an automatic move a centimetre
   * in and reports it as stalled.
   */
  collisionSensitivity?: 'leave' | 'high' | 'medium' | 'low';
  /**
   * Move the desk between sitting and standing on a timer. Off unless set.
   *
   * Present only as an accessory until it is switched on in the Home app: the
   * switch is the thing that starts it, so that turning it off is somewhere
   * obvious rather than in a config file. Configuring it here decides what it
   * does, not whether it is doing it.
   */
  autoMove?: AutoMoveConfig;
}

/** Weekday names as they appear in the config, Sunday first. */
export const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export type DayName = (typeof DAY_NAMES)[number];

export type EndOfDay = 'standing' | 'sitting' | 'nothing';

export interface AutoMoveConfig {
  /** Sitting height in millimetres. */
  sittingMm?: number;
  /** Standing height in millimetres. */
  standingMm?: number;
  /** Minutes at one height before moving to the other. */
  intervalMinutes?: number;
  /** Minutes of warning before a move. */
  warnMinutes?: number;
  /**
   * When it may move, as `"08:00-12:00"`.
   *
   * Strings rather than a pair of fields per row, because the Homebridge UI
   * renders a list of text boxes and a list of nested objects very differently,
   * and only one of them is pleasant to edit.
   */
  windows?: string[];
  /** Which days it runs on. Monday to Friday unless said otherwise. */
  days?: DayName[];
  /**
   * Switch auto movement off again at the end of each day.
   *
   * The switch then means "move me today" rather than "move me from now on",
   * and each morning is a decision. Off by default, so the switch keeps the
   * behaviour it has: once on, on until switched off.
   */
  switchOffDaily?: boolean;
  /**
   * Where to move the desk when the day's last window closes: `standing`,
   * `sitting`, or `nothing`, the default. Only with auto movement on, and only
   * within a quarter of an hour of the close.
   */
  endOfDay?: EndOfDay;
  /**
   * Show the countdown as a slider in the Home app.
   *
   * A <b>Timer</b> light whose brightness is how much of the interval is left,
   * which is also how it is set: drag it and the next move comes sooner or
   * later. On by default — the timer was running either way, and a countdown
   * nobody can see is a desk that moves without warning.
   */
  timerSlider?: boolean;
}

export const DEFAULT_AUTO_MOVE = {
  sittingMm: 800,
  standingMm: 1200,
  intervalMinutes: 30,
  warnMinutes: 5,
  windows: ['08:00-12:00', '13:00-16:00'],
  days: ['mon', 'tue', 'wed', 'thu', 'fri'] as DayName[],
  switchOffDaily: false,
  timerSlider: true,
  endOfDay: 'nothing' as EndOfDay,
};

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
  if (desk.turbo !== undefined && typeof desk.turbo !== 'boolean') {
    problems.push(`${where}.turbo must be true or false`);
  }
  if (
    desk.collisionSensitivity !== undefined &&
    !['leave', 'high', 'medium', 'low'].includes(desk.collisionSensitivity)
  ) {
    problems.push(
      `${where}.collisionSensitivity must be "leave", "high", "medium" or "low"`,
    );
  }
  return problems;
}

/**
 * Check the auto-move block, if there is one.
 *
 * Kept out of {@link validateDeskConfig} on purpose: a desk whose config does
 * not validate is dropped altogether, and losing the desk from HomeKit because
 * a warning interval was typed wrong is wildly out of proportion. These
 * problems disable auto-movement and leave the desk alone.
 *
 * Every field has a default, so the only things worth complaining about are
 * values that would make it behave in a way nobody could have meant: a sitting
 * height above the standing one, an interval shorter than the warning that is
 * supposed to precede it, a window that cannot be read.
 */
export function validateAutoMove(auto: AutoMoveConfig | undefined, where: string): string[] {
  if (auto === undefined) {
    return [];
  }
  const problems: string[] = [];
  const at = `${where}.autoMove`;

  const positive = (value: number | undefined, name: string): number | undefined => {
    if (value === undefined) {
      return undefined;
    }
    if (!Number.isFinite(value) || value <= 0) {
      problems.push(`${at}.${name} must be a positive number`);
      return undefined;
    }
    return value;
  };

  const sitting = positive(auto.sittingMm, 'sittingMm');
  const standing = positive(auto.standingMm, 'standingMm');
  const interval = positive(auto.intervalMinutes, 'intervalMinutes');

  // Zero is allowed here and nowhere else: it means "do not warn me", which is
  // a real answer rather than a missing one.
  let warn = auto.warnMinutes;
  if (warn !== undefined && (!Number.isFinite(warn) || warn < 0)) {
    problems.push(`${at}.warnMinutes must be zero or a positive number`);
    warn = undefined;
  }

  if (sitting !== undefined && standing !== undefined && sitting >= standing) {
    problems.push(`${at}.sittingMm must be below standingMm`);
  }
  if (interval !== undefined && warn !== undefined && warn > 0 && warn >= interval) {
    problems.push(
      `${at}.warnMinutes (${warn}) must be shorter than intervalMinutes (${interval}), ` +
        'or the warning would arrive before the previous move had finished',
    );
  }

  if (auto.windows !== undefined) {
    if (!Array.isArray(auto.windows)) {
      problems.push(`${at}.windows must be a list like ["08:00-12:00"]`);
    } else {
      for (const [i, window] of auto.windows.entries()) {
        if (typeof window !== 'string' || parseWindow(window) === null) {
          problems.push(
            `${at}.windows[${i}] must look like "08:00-12:00", and end after it starts ` +
              `(got ${JSON.stringify(window)})`,
          );
        }
      }
    }
  }

  if (auto.switchOffDaily !== undefined && typeof auto.switchOffDaily !== 'boolean') {
    problems.push(`${at}.switchOffDaily must be true or false`);
  }
  if (auto.endOfDay !== undefined && !['standing', 'sitting', 'nothing'].includes(auto.endOfDay)) {
    problems.push(`${at}.endOfDay must be "standing", "sitting" or "nothing"`);
  }
  if (auto.timerSlider !== undefined && typeof auto.timerSlider !== 'boolean') {
    problems.push(`${at}.timerSlider must be true or false`);
  }

  if (auto.days !== undefined) {
    if (!Array.isArray(auto.days)) {
      problems.push(`${at}.days must be a list of weekdays`);
    } else {
      for (const day of auto.days) {
        if (!DAY_NAMES.includes(day)) {
          problems.push(`${at}.days has ${JSON.stringify(day)}; expected one of ${DAY_NAMES.join(', ')}`);
        }
      }
    }
  }

  return problems;
}
