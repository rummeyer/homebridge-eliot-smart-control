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
import { Cmd, Report, readHeight } from './protocol.ts';
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
   * The control box reports height unprompted while it moves, so this is only
   * for what happens in between: someone using the handset, or a desk that was
   * moved while we were disconnected. Cheap, and the alternative is a Home app
   * showing a height from an hour ago.
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
  /** A memory move is finished once the height has held still this long. */
  nativeSettleMs: number;
  /** How far off a memory height still counts as being at that preset. */
  memoryToleranceMm: number;
}

export const DEFAULT_DESK_OPTIONS: DeskOptions = {
  idlePollMs: 30_000,
  externalMoveMm: 15,
  settleMs: 3000,
  move: {},
  nativeSettleMs: 1500,
  memoryToleranceMm: 12,
};

/** How often the move loop wakes up. Well under `pulseMs`. */
const TICK_MS = 50;

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

  #move: {
    controller: MoveController;
    settle: (outcome: MoveOutcome) => void;
  } | null = null;

  /**
   * A move the control box is driving by itself, after a memory command.
   *
   * Nothing here steers it — the box has its own ramp and stops on its own.
   * This only watches the height reports so the plugin knows when it is over
   * and which way it went.
   */
  #native: {
    target: number;
    direction: Direction;
    settle: (outcome: MoveOutcome) => void;
    lastHeight: number;
    lastChangeAt: number;
    deadline: number;
  } | null = null;
  #nativeTimer: NodeJS.Timeout | null = null;
  #timer: NodeJS.Timeout | null = null;
  #poll: NodeJS.Timeout | null = null;
  /** Until when height changes are the tail of our own move, not somebody's. */
  #settleUntil = 0;
  #closing = false;
  #refreshed = false;

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
    for (const command of [Cmd.WAKE, Cmd.SETTINGS, Cmd.RANGE, Cmd.LIMITS]) {
      if (!this.#transport.connected) {
        return;
      }
      await this.#transport.send(command);
      await delay(250);
    }
    this.#refreshed = true;
    this.#emitChange();
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
    this.#endMove('superseded');
    this.#targetMm = targetMm;

    const controller = new MoveController(targetMm, this.#heightMm, Date.now(), this.#opts.move);
    const outcome = new Promise<MoveOutcome>((resolve) => {
      this.#move = { controller, settle: resolve };
    });

    this.#log.info(`moving to ${percent}% (${targetMm} mm) from ${this.#heightMm} mm`);
    this.#emitChange();
    this.#tick();
    if (this.#move) {
      this.#timer = setInterval(() => this.#tick(), TICK_MS);
      this.#timer.unref();
    }
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
   * The consequence is that the move cannot be called off once it has started
   * — there is no command for that, and {@link stop} has nothing to withhold.
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
    this.#endMove('superseded');
    this.#endNative('superseded');

    const from = this.#heightMm;
    this.#targetMm = target;
    this.#log.info(`memory ${slot}: ${from} → ${target} mm`);

    const outcome = new Promise<MoveOutcome>((resolve) => {
      const now = Date.now();
      this.#native = {
        target,
        direction: target >= from ? 'up' : 'down',
        settle: resolve,
        lastHeight: from,
        lastChangeAt: now,
        // Generous: the box ramps, so it is slower than a flat-out step move.
        deadline: now + (Math.abs(target - from) / 6) * 1000 + 10_000,
      };
    });

    try {
      await this.#transport.send(command);
    } catch (error) {
      this.#log.debug(`memory command failed: ${String(error)}`);
      this.#endNative('disconnected');
      return outcome;
    }

    this.#nativeTimer = setInterval(() => this.#watchNative(), 250);
    this.#nativeTimer.unref();
    this.#emitChange();
    return outcome;
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
    this.#log.info(`memory move ended: ${outcome} at ${this.#heightMm} mm`);
    native.settle(outcome);
    this.emit('move-end', outcome);
    this.#emitChange();
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
      // Nothing to withhold: the box is driving itself and the protocol has no
      // way to call it back. Saying so beats silently doing nothing.
      this.#log.warn('cannot stop a memory move — the control box finishes it by itself');
    }
    if (this.#move) {
      this.#log.info('stopping');
      this.#endMove('superseded');
      this.#targetMm = this.#heightMm;
      this.#emitChange();
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
