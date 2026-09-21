/**
 * The desk as a thing with a state, sitting between the transport and HomeKit.
 *
 * Holds what the control box has told us, keeps it current, and runs moves to
 * completion. Depends on {@link Transport} rather than on `DeskLink` so the
 * whole orchestration layer — where a move is cancelled mid-flight, where a
 * disconnect interrupts one, where the handset moves the desk behind our back —
 * can be tested without Bluetooth.
 */
import { EventEmitter } from 'node:events';

import type { LinkLogger } from './link.ts';
import { MoveController, heightToPercent, percentToHeight } from './move.ts';
import type { Direction, MoveOptions, MoveResult } from './move.ts';
import { Cmd, Report, heightParams, readHeight } from './protocol.ts';
import type { Frame } from './protocol.ts';

/** What {@link Desk} needs from a transport. `DeskLink` satisfies it. */
export interface Transport {
  readonly connected: boolean;
  on(event: 'frame', listener: (frame: Frame) => void): unknown;
  on(event: 'connected', listener: () => void): unknown;
  on(event: 'disconnected', listener: () => void): unknown;
  send(command: number, params?: Buffer | number[]): Promise<void>;
  start(): Promise<void>;
  close(): Promise<void>;
}

/** How a move ended, including the ways that are nothing to do with the desk. */
export type MoveOutcome =
  | MoveResult
  /** A newer target replaced this one before it finished. */
  | 'superseded'
  /** The link went away mid-move. */
  | 'disconnected'
  /** Never started: no state, or the target was out of range. */
  | 'refused';

/**
 * The control box's own configuration, as it reports it.
 *
 * Every field is `null` until the settings block arrives, and the block only
 * arrives in answer to `CONNECT`. The app keeps a copy of these on the phone
 * and writes it to the desk when it connects, so they can change without this
 * plugin doing anything — which is the reason for reading them back rather
 * than remembering what was last sent.
 */
export interface DeskSettings {
  /** Firmware version as the box reports it, unscaled. */
  firmware: number | null;
  /** Travel speed. The app offers 28, 31, 35, 38 and 40. */
  velocity: number | null;
  /** Eco mode. Takes effect only after the desk is reset — see README. */
  lowPower: boolean | null;
  /** How the desk responds to a memory button; the mapping is unconfirmed. */
  motionMode: number | null;
  /** Anti-collision sensitivity: `1` high, `2` medium, `3` low. */
  sensitivity: number | null;
  /** What the desk's own display shows. */
  units: 'cm' | 'inch' | null;
}

const UNKNOWN_SETTINGS: DeskSettings = {
  firmware: null,
  velocity: null,
  lowPower: null,
  motionMode: null,
  sensitivity: null,
  units: null,
};

export interface DeskState {
  connected: boolean;
  /**
   * Whether a full refresh has completed, so the numbers can be trusted.
   *
   * Between connecting and the limits arriving, the same height reads as a
   * different percentage: the physical range is known first and the soft
   * limits replace it a moment later. Publishing in that window shows a
   * position that then jumps for no reason the user can see.
   */
  ready: boolean;
  /** Current height, or null before the desk has told us. */
  heightMm: number | null;
  /** Usable travel: the soft limits if set, otherwise the physical range. */
  minMm: number | null;
  maxMm: number | null;
  /** Height as HomeKit's 0–100, or null before we know. */
  position: number | null;
  /** Where we are driving to, or equal to `position` when at rest. */
  target: number | null;
  /** Which way the desk is going right now. */
  moving: 'up' | 'down' | null;
  /**
   * Whether the desk's own child lock is on, or `null` before it has said.
   *
   * Unlike the fields in {@link DeskState.settings} this one answers its own
   * command, so it is known even before the settings block arrives.
   */
  locked: boolean | null;
  /** What the control box reports about its own configuration. */
  settings: DeskSettings;
  /**
   * The four memory heights in millimetres, `null` where unset.
   *
   * These are the positions behind the handset's memory buttons. The control
   * box drives to them itself, on its own ramp, so they are both more accurate
   * and gentler than anything this plugin can do with step commands.
   */
  memories: (number | null)[];
}

export interface DeskOptions {
  /**
   * How often to ask for the height while idle.
   *
   * The control box streams its height while it drives itself, so this is only
   * for what happens in between: someone using the handset, or a desk that was
   * moved while we were disconnected.
   *
   * It must stay well clear of a move. `SETTINGS` is a command, and one that
   * lands while the box is driving to a position abandons the move — polling at
   * a few hundred milliseconds reduces every move to about ten millimetres.
   * Thirty seconds is idle-only by a wide margin.
   */
  idlePollMs: number;
  /**
   * How far the desk must be from where it was resting to count as moved.
   *
   * Measured against the resting height, not the previous reading. The control
   * box's height wanders by a few millimetres between reports on a desk nobody
   * is touching, so comparing consecutive readings reports phantom movement;
   * comparing against the last settled position absorbs that, while a real
   * move still accumulates past the threshold however slowly it is made.
   *
   * Above the observed noise of about 5 mm, and below the ~18 mm the desk
   * needs to stop — a move smaller than that cannot be made deliberately.
   */
  externalMoveMm: number;
  /**
   * How long after a move to keep treating height changes as our own.
   *
   * The desk drifts ~18 mm after the last pulse, well past
   * `externalMoveMm`, so without this window every move ends by looking like
   * somebody grabbing the handset.
   */
  settleMs: number;
  /** Passed through to {@link MoveController}. */
  move: Partial<MoveOptions>;
  /** A move the control box drives is finished once height holds still this long. */
  nativeSettleMs: number;
  /**
   * How long to wait for a `GOTO_HEIGHT` to get the desk moving.
   *
   * The command is absent from older control boxes, and one that does not
   * know it simply says nothing. Rather than reporting a desk that will not
   * move, the step-command loop takes over after this — slower and less
   * accurate, but it works on anything that speaks the handset protocol.
   */
  nativeStartMs: number;
  /** How far off a memory height still counts as being at that preset. */
  memoryToleranceMm: number;
  /**
   * Eco mode to store on the desk, with the travel speed that goes with it.
   *
   * `undefined` leaves the desk's own setting alone, which is the default and
   * the only honest one: writing it stores a change that takes effect at the
   * next reset, which may be weeks away and nowhere near this decision.
   */
  eco?: boolean;
}

/**
 * The travel speeds that go with eco on and eco off.
 *
 * The app offers 28, 31, 35, 38 and 40 and nothing outside that, so these are
 * its ends rather than the box's: this desk was found storing 21, below
 * anything the app will produce, which says the box accepts more than the app
 * offers and says nothing about what is good for it. Staying inside the range
 * the manufacturer's own app uses is the conservative choice for a value that
 * only takes effect after a reset, where a bad one is discovered late.
 */
const ECO_VELOCITY = 28;
const FAST_VELOCITY = 40;

export const DEFAULT_DESK_OPTIONS: DeskOptions = {
  idlePollMs: 30_000,
  externalMoveMm: 15,
  settleMs: 3000,
  move: {},
  nativeSettleMs: 1500,
  nativeStartMs: 2500,
  memoryToleranceMm: 12,
};

/** How often the step-command loop wakes up. Well under `pulseMs`. */
const TICK_MS = 50;

/** Parameter to {@link Cmd.LOCK} that asks rather than changes. */
const LOCK_QUERY = 0x00;
/** Parameter to {@link Cmd.LOCK} that flips it. */
const LOCK_TOGGLE = 0x01;

/**
 * A move the control box is driving by itself.
 *
 * Nothing here steers it — the box has its own ramp and stops on its own.
 * This is only what is needed to tell when it is over, which way it went, and
 * whether it ever started.
 */
interface NativeMove {
  target: number;
  direction: Direction;
  settle: (outcome: MoveOutcome) => void;
  lastHeight: number;
  lastChangeAt: number;
  deadline: number;
  startedAt: number;
  /** A slider move can fall back to step commands; a memory move need not. */
  fallback: boolean;
  /** Whether the desk has been seen to move since the command went out. */
  moved: boolean;
}

export interface Desk {
  on(event: 'change', listener: (state: DeskState) => void): this;
  on(event: 'move-end', listener: (outcome: MoveOutcome) => void): this;
}

export class Desk extends EventEmitter {
  readonly #transport: Transport;
  readonly #log: LinkLogger;
  readonly #opts: DeskOptions;

  #heightMm: number | null = null;
  #softMin: number | null = null;
  #softMax: number | null = null;
  #physMin: number | null = null;
  #physMax: number | null = null;
  #targetMm: number | null = null;
  /** Where the desk was last settled, for telling real movement from noise. */
  #restingMm: number | null = null;

  #memories: (number | null)[] = [null, null, null, null];
  #locked: boolean | null = null;
  #settings: DeskSettings = { ...UNKNOWN_SETTINGS };

  #move: {
    controller: MoveController;
    settle: (outcome: MoveOutcome) => void;
  } | null = null;

  #native: NativeMove | null = null;
  #nativeTimer: NodeJS.Timeout | null = null;
  #timer: NodeJS.Timeout | null = null;
  #poll: NodeJS.Timeout | null = null;
  /** Until when height changes are the tail of our own move, not somebody's. */
  #settleUntil = 0;
  #closing = false;
  #refreshed = false;
  /** Whether the configured eco pair has been dealt with on this connection. */
  #ecoApplied = false;

  constructor(transport: Transport, log: LinkLogger, options: Partial<DeskOptions> = {}) {
    super();
    this.#transport = transport;
    this.#log = log;
    this.#opts = { ...DEFAULT_DESK_OPTIONS, ...options };

    transport.on('frame', (frame) => this.#onFrame(frame));
    transport.on('connected', () => void this.#onConnected());
    transport.on('disconnected', () => this.#onDisconnected());
  }

  get state(): DeskState {
    const min = this.minMm;
    const max = this.maxMm;
    const position =
      this.#heightMm !== null && min !== null && max !== null
        ? heightToPercent(this.#heightMm, min, max)
        : null;
    const target =
      this.#targetMm !== null && min !== null && max !== null
        ? heightToPercent(this.#targetMm, min, max)
        : position;

    return {
      connected: this.#transport.connected,
      ready: this.#refreshed && position !== null,
      heightMm: this.#heightMm,
      minMm: min,
      maxMm: max,
      position,
      target,
      moving: this.#move?.controller.direction ?? this.#native?.direction ?? null,
      locked: this.#locked,
      settings: { ...this.#settings },
      memories: [...this.#memories],
    };
  }

  /** Soft minimum if the desk has one, else its physical floor. */
  get minMm(): number | null {
    return this.#softMin ?? this.#physMin;
  }

  /** Soft maximum if the desk has one, else its physical ceiling. */
  get maxMm(): number | null {
    return this.#softMax ?? this.#physMax;
  }

  async start(): Promise<void> {
    this.#closing = false;
    await this.#transport.start();
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#endMove('disconnected');
    this.#endNative('disconnected');
    this.#stopPolling();
    await this.#transport.close();
  }

  /**
   * Ask the desk for everything it will tell us about itself.
   *
   * `LIMITS` goes last on purpose: it is the answer that decides what 0% and
   * 100% mean, and nothing should be published before it lands.
   */
  async refresh(): Promise<void> {
    const questions: [number, number[]][] = [
      [Cmd.WAKE, []],
      [Cmd.SETTINGS, []],
      [Cmd.RANGE, []],
      [Cmd.LOCK, [LOCK_QUERY]],
      [Cmd.LIMITS, []],
    ];
    for (const [command, params] of questions) {
      if (!this.#transport.connected) {
        return;
      }
      await this.#transport.send(command, params);
      await delay(250);
    }
    this.#refreshed = true;
    this.#emitChange();

    // The settings block comes after readiness, deliberately. None of it feeds
    // the height or the limits, so making the desk wait on it would delay the
    // first trustworthy position for the sake of a firmware string.
    if (this.#transport.connected) {
      await this.#transport.send(Cmd.CONNECT);
    }
  }

  /**
   * Drive to a HomeKit position, 0–100.
   *
   * Resolves when the move ends, however it ends. A second call while one is
   * running replaces it: the first resolves `superseded` and the desk carries
   * straight on towards the new target without stopping in between.
   */
  async moveTo(percent: number): Promise<MoveOutcome> {
    const min = this.minMm;
    const max = this.maxMm;
    if (min === null || max === null || this.#heightMm === null) {
      this.#log.warn('cannot move: the desk has not said where it is yet');
      return 'refused';
    }
    if (!this.#transport.connected) {
      return 'disconnected';
    }

    const targetMm = percentToHeight(percent, min, max);
    this.#log.info(`moving to ${percent}% (${targetMm} mm) from ${this.#heightMm} mm`);
    return this.#drive(targetMm, Cmd.GOTO_HEIGHT, heightParams(targetMm), true);
  }

  /**
   * Hand a destination to the control box and watch.
   *
   * Used for both the slider and the memory buttons, because both are the
   * same thing from here: one command, then the box runs its own ramp. The
   * plugin's own step loop is a fallback for a slider move on a control box
   * that does not know {@link Cmd.GOTO_HEIGHT}; a memory command is older
   * than this plugin and needs none.
   */
  async #drive(
    targetMm: number,
    command: number,
    params: number[],
    fallback: boolean,
  ): Promise<MoveOutcome> {
    const from = this.#heightMm;
    if (from === null) {
      return 'refused';
    }

    this.#endMove('superseded');
    // Awaited, not fired and forgotten: the step command behind STOP would
    // otherwise land after the new destination and cancel that instead.
    await this.#cancelNative();
    this.#endNative('superseded');
    this.#targetMm = targetMm;

    const outcome = new Promise<MoveOutcome>((resolve) => {
      const now = Date.now();
      this.#native = {
        target: targetMm,
        direction: targetMm >= from ? 'up' : 'down',
        settle: resolve,
        lastHeight: from,
        lastChangeAt: now,
        startedAt: now,
        fallback,
        moved: false,
        // Generous: the box ramps, so it is slower than a flat-out step move.
        deadline: now + (Math.abs(targetMm - from) / 6) * 1000 + 10_000,
      };
    });

    try {
      await this.#transport.send(command, params);
    } catch (error) {
      this.#log.debug(`move command failed: ${String(error)}`);
      this.#endNative('disconnected');
      return outcome;
    }

    this.#nativeTimer = setInterval(() => this.#watchNative(), 250);
    this.#nativeTimer.unref();
    this.#emitChange();
    return outcome;
  }

  /**
   * Drive to one of the desk's four memory positions, numbered 1 to 4.
   *
   * Sent as a single command and then left alone: the control box runs its own
   * ramp, decelerating into the target and stopping within a couple of
   * millimetres. That is better than this plugin can manage with step
   * commands, so a preset is not simply {@link moveTo} with a stored height.
   *
   * It can still be called off: see {@link stop}.
   */
  async moveToMemory(slot: number): Promise<MoveOutcome> {
    const target = this.#memories[slot - 1];
    if (target == null) {
      this.#log.warn(`memory ${slot} is not set on this desk`);
      return 'refused';
    }
    if (this.#heightMm === null || !this.#transport.connected) {
      return this.#transport.connected ? 'refused' : 'disconnected';
    }

    const command = [Cmd.MOVE_1, Cmd.MOVE_2, Cmd.MOVE_3, Cmd.MOVE_4][slot - 1];
    this.#log.info(`memory ${slot}: ${this.#heightMm} → ${target} mm`);
    return this.#drive(target, command, [], false);
  }

  /** Decide whether a control-box-driven move has finished, or gone wrong. */
  #watchNative(): void {
    const native = this.#native;
    if (!native) {
      return;
    }
    if (!this.#transport.connected) {
      this.#endNative('disconnected');
      return;
    }

    const now = Date.now();
    const height = this.#heightMm;
    if (height !== null && height !== native.lastHeight) {
      native.lastHeight = height;
      native.lastChangeAt = now;
      native.moved = true;
    }

    // A desk that has not moved at all has not finished — it has not begun,
    // which is a different thing and wants a different answer. Silence this
    // early means the command was not understood rather than that the desk
    // stopped, so this has to be decided before the settling check below.
    if (!native.moved) {
      if (now - native.startedAt > this.#opts.nativeStartMs) {
        if (native.fallback) {
          this.#fallBackToSteps(native);
        } else {
          this.#log.warn('the control box did not act on the command');
          this.#endNative('stalled');
        }
      }
      return;
    }

    if (now > native.deadline) {
      this.#endNative('timeout');
      return;
    }
    // Still for long enough means it has stopped; whether that counts as
    // arriving depends only on where it stopped.
    if (now - native.lastChangeAt >= this.#opts.nativeSettleMs) {
      const off = height === null ? Infinity : Math.abs(height - native.target);
      this.#endNative(off <= this.#opts.memoryToleranceMm ? 'arrived' : 'stalled');
    }
  }

  /**
   * Take over a move the control box ignored, using step commands.
   *
   * The pending promise is carried across rather than settled: the caller
   * asked to reach a height and does not care which of the two ways got it
   * there, only how it ended.
   */
  #fallBackToSteps(native: NativeMove): void {
    if (this.#nativeTimer) {
      clearInterval(this.#nativeTimer);
      this.#nativeTimer = null;
    }
    this.#native = null;

    const from = this.#heightMm;
    if (from === null || !this.#transport.connected) {
      native.settle('disconnected');
      return;
    }

    this.#log.warn(
      'this control box does not appear to know GOTO_HEIGHT — falling back to step commands',
    );
    // Motion mode governs whether the box will drive to a position by itself,
    // so it is the first thing to suspect here. Which value means which is not
    // established — this desk drives happily on 0, while the published notes
    // call 0 one-touch and the app's own labels disagree — so report the
    // number and let whoever is reading the log compare it against the app,
    // rather than asserting a mapping that has never been verified.
    if (this.#settings.motionMode !== null) {
      this.#log.warn(
        `the desk reports motion mode ${this.#settings.motionMode}; if the app shows ` +
          'one-touch mode switched off, switching it on may restore direct moves',
      );
    }
    const controller = new MoveController(native.target, from, Date.now(), this.#opts.move);
    this.#move = { controller, settle: native.settle };
    this.#tick();
    if (this.#move) {
      this.#timer = setInterval(() => this.#tick(), TICK_MS);
      this.#timer.unref();
    }
  }

  #endNative(outcome: MoveOutcome): void {
    if (this.#nativeTimer) {
      clearInterval(this.#nativeTimer);
      this.#nativeTimer = null;
    }
    const native = this.#native;
    if (!native) {
      return;
    }
    this.#native = null;
    this.#settleUntil = Date.now() + this.#opts.settleMs;
    this.#restingMm = this.#heightMm;
    if (outcome !== 'arrived') {
      this.#targetMm = this.#heightMm;
    }
    this.#log.info(`move ended: ${outcome} at ${this.#heightMm} mm`);
    native.settle(outcome);
    this.emit('move-end', outcome);
    this.#emitChange();
  }

  /**
   * Turn the desk's child lock on or off.
   *
   * The control box offers a toggle, not a setting, so asking for the state
   * it is already in must send nothing — otherwise every refresh of a locked
   * desk would unlock it. The answer to the toggle carries the new state, so
   * nothing has to be assumed about whether it worked.
   */
  async setLocked(locked: boolean): Promise<boolean> {
    if (!this.#transport.connected) {
      return false;
    }
    if (this.#locked === locked) {
      return true;
    }
    await this.#transport.send(Cmd.LOCK, [LOCK_TOGGLE]);
    await delay(400);
    await this.#transport.send(Cmd.LOCK, [LOCK_QUERY]);
    await delay(400);
    return this.#locked === locked;
  }

  /**
   * Stop where it is.
   *
   * There is no stop command — the desk halts because we stop asking it to
   * move — so this cannot be instant. It coasts the same ~18 mm it would at
   * the end of any move.
   */
  stop(): void {
    if (this.#native) {
      this.#log.info('stopping');
      void this.#cancelNative();
      this.#endNative('superseded');
      return;
    }
    if (this.#move) {
      this.#log.info('stopping');
      // Belt and braces: ceasing to pulse is enough on its own, but STOP
      // shortens the coast from about 18 mm to 13 mm.
      void this.#transport.send(Cmd.STOP).catch(() => {});
      this.#endMove('superseded');
      this.#targetMm = this.#heightMm;
      this.#emitChange();
    }
  }

  /**
   * Call off a move the control box is driving.
   *
   * `STOP` is the proper way and coasts about 13 mm. A step command also
   * cancels one, on this box at least, and is sent after it as insurance for
   * a control box that predates `STOP` — it is the same thing a handset press
   * does, and it goes the way the desk is already travelling so that being
   * wrong costs one extra step rather than a lurch backwards.
   */
  async #cancelNative(): Promise<void> {
    const native = this.#native;
    if (!native) {
      return;
    }
    const fallback = native.direction === 'up' ? Cmd.RAISE : Cmd.LOWER;
    try {
      await this.#transport.send(Cmd.STOP);
      await this.#transport.send(fallback);
    } catch (error) {
      this.#log.debug(`stopping failed: ${String(error)}`);
    }
  }

  #tick(): void {
    const move = this.#move;
    if (!move) {
      return;
    }
    if (!this.#transport.connected) {
      this.#endMove('disconnected');
      return;
    }

    const { send, result } = move.controller.step(Date.now());
    if (result) {
      this.#log.info(`move ended: ${result} at ${this.#heightMm} mm`);
      this.#endMove(result);
      return;
    }
    if (send) {
      // Fire and forget: the next tick re-decides from the reports that come
      // back, so a single failed write must not stall the loop. A link that is
      // really gone shows up as `disconnected` above or `lost` in the
      // controller, both of which stop the desk.
      void this.#transport
        .send(send === 'up' ? Cmd.RAISE : Cmd.LOWER)
        .catch((error: unknown) => this.#log.debug(`pulse failed: ${String(error)}`));
    }
  }

  #endMove(outcome: MoveOutcome): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    const move = this.#move;
    if (!move) {
      return;
    }
    this.#move = null;
    this.#settleUntil = Date.now() + this.#opts.settleMs;
    this.#restingMm = this.#heightMm;

    // On success the target stays where it was asked for. Reading it back off
    // the desk would throw the request away at the moment it succeeded, and
    // then follow the coast down — so HomeKit would watch a target it never
    // set drift by a few percent. Every other outcome means we are not going
    // there after all, and the target should say so.
    if (outcome !== 'arrived') {
      this.#targetMm = this.#heightMm;
    }

    move.settle(outcome);
    this.emit('move-end', outcome);
    this.#emitChange();
  }

  #onFrame(frame: Frame): void {
    switch (frame.command) {
      case Report.HEIGHT: {
        this.#onHeight(readHeight(frame.params));
        return;
      }
      case Report.RANGE:
        if (frame.params.length >= 4) {
          this.#physMax = readHeight(frame.params, 0);
          this.#physMin = readHeight(frame.params, 2);
          this.#emitChange();
        }
        return;
      case Report.LIMIT_MAX:
        this.#softMax = readHeight(frame.params);
        this.#emitChange();
        return;
      case Report.LIMIT_MIN:
        this.#softMin = readHeight(frame.params);
        this.#emitChange();
        return;
      case Report.POSITION_1:
      case Report.POSITION_2:
      case Report.POSITION_3:
      case Report.POSITION_4: {
        const slot = frame.command - Report.POSITION_1;
        // A memory the user has never set reads as zero, which is not a
        // height the desk could ever be at. Store it as unset so nothing
        // offers it as somewhere to go.
        const mm = readHeight(frame.params);
        this.#memories[slot] = mm > 0 ? mm : null;
        this.#emitChange();
        return;
      }
      case Report.LOCK:
        this.#locked = frame.params[0] === 1;
        this.#emitChange();
        return;
      case Report.UNITS:
      case Report.VELOCITY:
      case Report.LOW_POWER:
      case Report.MOTION_MODE:
      case Report.VERSION:
      case Report.SENSITIVITY: {
        // All six arrive together, as one frame each, in answer to CONNECT.
        const value = frame.params[0];
        if (value === undefined) {
          return;
        }
        this.#onSetting(frame.command, value);
        return;
      }
      case Report.LIMIT_FLAGS: {
        // Bit 0 is the max limit, bit 4 the min. A limit that is not set means
        // the physical end of travel, so forget any stale value rather than
        // keeping one the desk no longer honours.
        const flags = frame.params[0] ?? 0;
        if (!(flags & 0x01)) {
          this.#softMax = null;
        }
        if (!(flags & 0x10)) {
          this.#softMin = null;
        }
        this.#emitChange();
        return;
      }
      default:
        return;
    }
  }

  /**
   * Record one field of the settings block.
   *
   * The block is sent whole every time, so a field that has not changed still
   * arrives; only publish when something actually differs, or a refresh of an
   * untouched desk would wake every subscriber for nothing.
   */
  #onSetting(code: number, value: number): void {
    const before = { ...this.#settings };
    switch (code) {
      case Report.UNITS:
        this.#settings.units = value === 1 ? 'inch' : 'cm';
        break;
      case Report.VELOCITY:
        this.#settings.velocity = value;
        break;
      case Report.LOW_POWER:
        this.#settings.lowPower = value === 1;
        break;
      case Report.MOTION_MODE:
        this.#settings.motionMode = value;
        break;
      case Report.VERSION:
        this.#settings.firmware = value;
        break;
      case Report.SENSITIVITY:
        this.#settings.sensitivity = value;
        break;
      default:
        return;
    }
    const key = Object.keys(before) as (keyof DeskSettings)[];
    if (key.some((k) => before[k] !== this.#settings[k])) {
      this.#emitChange();
    }
    void this.#applyEco();
  }

  /**
   * Store the configured eco pair, if the desk is not already holding it.
   *
   * Runs once per connection and only when something differs, because the
   * write is not free: the box stores it and keeps running what it was last
   * reset with, so every write leaves a change primed to go off at a reset that
   * may be weeks away. Writing the same values again on every reconnect would
   * be harmless in effect and dishonest in the log, which is where anyone will
   * go looking when the desk changes speed for no reason they can remember.
   *
   * Both fields have to have arrived before this can tell whether anything
   * differs, which is why it hangs off the settings block rather than the
   * connection.
   */
  async #applyEco(): Promise<void> {
    if (this.#ecoApplied) {
      return;
    }
    const { lowPower, velocity } = this.#settings;
    if (lowPower === null || velocity === null) {
      return;
    }
    this.#ecoApplied = true;

    // Said on every connection, whether or not anything is configured. Nothing
    // else can tell you: the settings page cannot read the desk, because this
    // plugin is holding the dongle's only connection. And the desk itself will
    // not tell you either — what it reports is what it has stored, which is not
    // necessarily what it is running.
    this.#log.info(
      `the desk stores eco mode ${lowPower ? 'on' : 'off'} at travel speed ${velocity}` +
        ' (what it is running is whatever it was last reset with)',
    );

    const eco = this.#opts.eco;
    if (eco === undefined) {
      return;
    }

    const wantVelocity = eco ? ECO_VELOCITY : FAST_VELOCITY;
    if (lowPower === eco && velocity === wantVelocity) {
      return;
    }
    if (!this.#transport.connected) {
      return;
    }

    await this.#transport.send(Cmd.LOW_POWER, [eco ? 1 : 0]);
    await delay(300);
    await this.#transport.send(Cmd.VELOCITY, [wantVelocity]);

    this.#log.warn(
      `eco mode ${eco ? 'on' : 'off'} and travel speed ${wantVelocity} stored on the desk ` +
        `(it had ${lowPower ? 'on' : 'off'} and ${velocity}). The desk keeps running its ` +
        'old setting until it is reset by hand: drive it to the bottom and hold the down ' +
        'key until it re-homes. No command can do this.',
    );
  }

  #onHeight(heightMm: number): void {
    this.#heightMm = heightMm;

    if (this.#move) {
      this.#move.controller.report(heightMm, Date.now());
      this.#emitChange();
      return;
    }

    if (this.#native) {
      // The control box is driving. Watching is all we do; #watchNative reads
      // the height from here on its own schedule.
      this.#emitChange();
      return;
    }

    if (Date.now() < this.#settleUntil) {
      // Still coasting from our own last pulse; our own target stands.
      this.#restingMm = heightMm;
      this.#emitChange();
      return;
    }

    const resting = this.#restingMm;
    if (resting !== null && Math.abs(heightMm - resting) < this.#opts.externalMoveMm) {
      // Within the noise of where it was already sitting. Report the height,
      // but do not read intent into it.
      this.#emitChange();
      return;
    }

    // Nobody here asked for this. Either the handset moved it or it was moved
    // while we were away; either way the target follows the desk rather than
    // the desk being dragged back to a target it never agreed to.
    if (resting !== null) {
      this.#log.debug(`moved elsewhere: ${resting} → ${heightMm} mm`);
    }
    this.#restingMm = heightMm;
    this.#targetMm = heightMm;
    this.#emitChange();
  }

  async #onConnected(): Promise<void> {
    this.#emitChange();
    try {
      await this.refresh();
    } catch (error) {
      this.#log.debug(`refresh after connect failed: ${String(error)}`);
    }
    this.#startPolling();
  }

  #onDisconnected(): void {
    // The desk may be moved by hand while we are away, so nothing we hold is
    // trustworthy until it has been asked again.
    this.#refreshed = false;
    this.#ecoApplied = false;
    this.#locked = null;
    this.#endMove('disconnected');
    this.#endNative('disconnected');
    this.#stopPolling();
    this.#emitChange();
  }

  #startPolling(): void {
    this.#stopPolling();
    if (this.#closing || this.#opts.idlePollMs <= 0) {
      return;
    }
    this.#poll = setInterval(() => {
      // Only while at rest: during a move the desk is already talking, and an
      // extra request would just compete with the pulses for the link.
      if (!this.#move && this.#transport.connected) {
        void this.#transport.send(Cmd.SETTINGS).catch(() => {});
      }
    }, this.#opts.idlePollMs);
    this.#poll.unref();
  }

  #stopPolling(): void {
    if (this.#poll) {
      clearInterval(this.#poll);
      this.#poll = null;
    }
  }

  #emitChange(): void {
    this.emit('change', this.state);
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
