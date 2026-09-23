/**
 * One desk as a HomeKit window covering.
 *
 * A covering rather than a light, because a desk is a positional actuator that
 * takes time to get there: `PositionState` says which way it is going and
 * `HoldPosition` stops it, neither of which a dimmer can express. It also
 * keeps the desk out of "turn off all the lights", which would otherwise drive
 * it to its lowest setting at bedtime.
 */
import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import { AutoMover } from './auto-move.ts';
import { DAY_NAMES, DEFAULT_AUTO_MOVE, validateAutoMove } from './config.ts';
import type { DeskConfig } from './config.ts';
import { Desk } from './eliot/desk.ts';
import type { DeskState, MoveOutcome, Transport } from './eliot/desk.ts';
import { DeskLink } from './eliot/link.ts';
import { heightToPercent } from './eliot/move.ts';
import type { EliotPlatform } from './platform.ts';

/**
 * How far off target a finished move may be and still report as arrived.
 *
 * The desk stops within about 3 mm, but it cannot make a move shorter than its
 * ~18 mm stopping distance, so a request can legitimately land 2–3% out. Home
 * shows "Moving to 35%…" for as long as the current position differs from the
 * target, which for a desk means forever. Snapping the reported position onto
 * the target at the end of a successful move trades a percent of precision for
 * a state the user can make sense of.
 */
const SNAP_TOLERANCE_PERCENT = 3;

/**
 * How often to ask the scheduler what it wants.
 *
 * Half a minute is fine: everything it decides is measured in minutes, and a
 * warning or a move landing up to 30 s late is not something anyone could
 * notice. It costs nothing — the poll does not touch the desk.
 */
const AUTO_TICK_MS = 30_000;

/**
 * How long to let slider targets settle before acting on one.
 *
 * Dragging the slider produces a stream of targets, and each one taken
 * literally means stopping the desk, waiting out its coast and handing it a new
 * destination — a burst of Bluetooth traffic at a control box that answers a
 * command arriving mid-move by abandoning the move. Only the last target in a
 * drag was ever wanted.
 *
 * Short enough that a single tap still feels immediate, and the desk needs
 * about a second to get going in any case.
 */
const TARGET_SETTLE_MS = 300;

/** The desk has four memory buttons; we mirror however many are in use. */
const MEMORY_SLOTS = [1, 2, 3, 4];

/** How long a momentary switch stays on before springing back. */
const RELEASE_MS = 1_000;

/**
 * The configured eco mode as a boolean, or undefined for "leave it alone".
 *
 * Booleans are the 1.2.0 spelling and still mean what they meant; anything
 * unrecognised is treated as "leave alone", which is the option that changes
 * nothing on somebody's desk.
 */
function wantsEco(setting: DeskConfig['ecoMode']): boolean | undefined {
  if (typeof setting === 'boolean') {
    return setting;
  }
  if (setting === 'on') {
    return true;
  }
  if (setting === 'off') {
    return false;
  }
  return undefined;
}

/**
 * The configured anti-collision sensitivity as the box numbers it, or
 * undefined for "leave it alone".
 *
 * `1` high, `2` medium, `3` low — the box's own scale, which runs the opposite
 * way to how the words read, so it is spelled out here once rather than
 * remembered at the call site.
 */
function wantsSensitivity(setting: DeskConfig['collisionSensitivity']): number | undefined {
  switch (setting) {
    case 'high':
      return 1;
    case 'medium':
      return 2;
    case 'low':
      return 3;
    default:
      return undefined;
  }
}

export class EliotAccessory {
  readonly #platform: EliotPlatform;
  readonly #accessory: PlatformAccessory;
  readonly #config: DeskConfig;
  readonly #desk: Desk;
  readonly #service: Service;

  /** Position to report instead of the real one, after a successful move. */
  #snapTo: number | null = null;
  /** Last firmware version published, so it is only written when it changes. */
  #firmware: number | null = null;
  /** Memory switches by slot, created lazily once the desk lists its memories. */
  readonly #memoryServices = new Map<number, Service>();
  #lockService: Service | undefined;
  /** Auto-movement, when it is configured at all. */
  #autoService: Service | undefined;
  #warnService: Service | undefined;
  /** The countdown as a slider, when it is wanted. */
  #timerService: Service | undefined;
  /** The writes one slider gesture produces, and the timer waiting for the rest. */
  #timerGesture: { on?: boolean; brightness?: number } = {};
  #timerSettle: NodeJS.Timeout | undefined;
  /** The percentage last shown, so a tick that changes nothing stays quiet. */
  #timerShown: number | null = null;
  #mover: AutoMover | undefined;
  #autoTimer: NodeJS.Timeout | undefined;
  /** Heights already complained about, so the log says it once and not hourly. */
  readonly #clamped = new Set<string>();
  /** The last slider target, and the timer waiting to see if more follow. */
  #pendingTarget: number | null = null;
  #targetTimer: NodeJS.Timeout | undefined;

  /**
   * @param transport Stand-in for the Bluetooth link. Only tests pass one;
   *   in normal use the accessory builds its own. Without this seam there is
   *   no way to exercise the accessory without a desk in the room, and the
   *   handler wiring is exactly the part that needs exercising.
   */
  constructor(
    platform: EliotPlatform,
    accessory: PlatformAccessory,
    config: DeskConfig,
    transport?: Transport,
  ) {
    this.#platform = platform;
    this.#accessory = accessory;
    this.#config = config;

    const { Characteristic, Service: HapService } = platform.api.hap;

    const link = transport ?? new DeskLink(config.mac, platform.log);
    this.#desk = new Desk(link, platform.log, {
      idlePollMs: (config.idlePollSeconds ?? 30) * 1000,
      eco: wantsEco(config.ecoMode),
      sensitivity: wantsSensitivity(config.collisionSensitivity),
    });

    accessory
      .getService(HapService.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, 'Eliot')
      .setCharacteristic(Characteristic.Model, 'Smart Dongle')
      .setCharacteristic(Characteristic.SerialNumber, config.mac);

    // The version the desk gave last time, set before the bridge publishes.
    //
    // HomeKit reads the information service when the accessory database is
    // published and does not come back for it: FirmwareRevision cannot notify,
    // so a value written later is correct in this process and invisible in the
    // Home app. The settings block arrives about two seconds after connecting,
    // which is always too late. Remembering it across restarts is what makes it
    // visible — a desk seen for the first time shows nothing until its second
    // start, which is the price of not inventing a number.
    const remembered: unknown = accessory.context.firmware;
    if (typeof remembered === 'number') {
      this.#firmware = remembered;
      accessory
        .getService(HapService.AccessoryInformation)
        ?.setCharacteristic(Characteristic.FirmwareRevision, String(remembered));
    }

    this.#service =
      accessory.getService(HapService.WindowCovering) ??
      accessory.addService(HapService.WindowCovering, config.name);
    this.#name(this.#service, config.name);

    this.#service
      .getCharacteristic(Characteristic.CurrentPosition)
      .onGet(() => this.#currentPosition());

    this.#service
      .getCharacteristic(Characteristic.TargetPosition)
      .onGet(() => this.#targetPosition())
      .onSet((value) => this.#setTarget(value));

    this.#service
      .getCharacteristic(Characteristic.PositionState)
      .onGet(() => this.#positionState());

    this.#service
      .getCharacteristic(Characteristic.HoldPosition)
      .onSet((value) => {
        if (value) {
          this.#desk.stop();
        }
      });

    if (config.childLockSwitch !== false) {
      // Unlike the memory switches this needs nothing from the desk to exist,
      // so it is built here rather than waiting for the first report.
      const subtype = 'childlock';
      this.#lockService =
        accessory.getServiceById(HapService.Switch, subtype) ??
        accessory.addService(HapService.Switch, 'Child Lock', subtype);
      this.#name(this.#lockService, 'Child Lock');
      this.#lockService
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.#lockState())
        .onSet((value) => this.#setLock(Boolean(value)));
    }

    if (config.autoMove) {
      this.#setUpAutoMove(config);
    }

    this.#desk.on('change', (state) => {
      this.#syncFirmware(state);
      this.#syncMemorySwitches(state);
      this.#publish(state);
    });
    this.#desk.on('move-end', (outcome) => this.#onMoveEnd(outcome));
  }

  get name(): string {
    return this.#config.name;
  }

  /**
   * Build the auto-movement switch, its warning sensor and the scheduler.
   *
   * The switch is stateful and remembered in the accessory's context, because
   * "move my desk every half hour" is a standing decision and having it reset
   * itself whenever Homebridge restarts would be its own kind of surprise.
   *
   * The warning is a motion sensor for want of anything better: HomeKit gives
   * an accessory no way to send a notification, and a sensor is the one kind of
   * thing the Home app will offer to notify about. The owner turns that on once
   * under the sensor's Status and Notifications; nothing here can do it for
   * them, and if they never do, the feature still works in silence.
   */
  #setUpAutoMove(config: DeskConfig): void {
    const { Characteristic, Service: HapService } = this.#platform.api.hap;

    // A problem here costs auto-movement and nothing else. The desk, its
    // presets and its child lock are not this feature's to take away.
    const problems = validateAutoMove(config.autoMove, config.name);
    if (problems.length > 0) {
      for (const problem of problems) {
        this.#platform.log.error(`Auto movement is off: ${problem}`);
      }
      return;
    }

    const auto = { ...DEFAULT_AUTO_MOVE, ...config.autoMove };
    const warnMinutes = auto.warnMinutes > 0 ? auto.warnMinutes : 0;

    this.#mover = new AutoMover({
      sittingMm: auto.sittingMm,
      standingMm: auto.standingMm,
      intervalMinutes: auto.intervalMinutes,
      warnMinutes,
      windows: auto.windows,
      days: auto.days.map((d) => DAY_NAMES.indexOf(d)).filter((d) => d >= 0),
      switchOffDaily: auto.switchOffDaily,
    });
    // Restored, not switched on: the day it was switched on for comes back with
    // it, so a restart in the evening does not hand it a fresh day.
    this.#mover.restore(
      this.#accessory.context.autoMove === true,
      typeof this.#accessory.context.autoMoveDay === 'string'
        ? this.#accessory.context.autoMoveDay
        : null,
    );

    // Built before the switch and the sensor, because services are created in
    // the order they should be read: the desk, its lock, how long until it
    // moves, whether it moves at all, and the warning that goes with that.
    // HomeKit has no field for ordering and the Home app decides its own
    // layout, so this is a preference expressed rather than one enforced — and
    // it reaches an accessory restored from Homebridge's cache not at all,
    // since those services come back in the order they were first written.
    const timerSubtype = 'automove-timer';
    const restoredTimer = this.#accessory.getServiceById(HapService.Lightbulb, timerSubtype);
    if (!auto.timerSlider) {
      if (restoredTimer) {
        this.#accessory.removeService(restoredTimer);
      }
      this.#timerService = undefined;
    } else {
      this.#timerService =
        restoredTimer ?? this.#accessory.addService(HapService.Lightbulb, 'Timer', timerSubtype);
      this.#name(this.#timerService, 'Timer');
      this.#timerService
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.#mover?.enabled ?? false)
        .onSet((value) => this.#takeTimerWrite({ on: Boolean(value) }));
      this.#timerService
        .getCharacteristic(Characteristic.Brightness)
        .onGet(() => this.#mover?.remainingPercent() ?? 0)
        .onSet((value) => this.#takeTimerWrite({ brightness: Math.round(Number(value)) }));
      this.#publishTimer(true);
    }

    const switchSubtype = 'automove';
    this.#autoService =
      this.#accessory.getServiceById(HapService.Switch, switchSubtype) ??
      this.#accessory.addService(HapService.Switch, 'Auto Movement', switchSubtype);
    this.#name(this.#autoService, 'Auto Movement');
    this.#autoService
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.#mover?.enabled ?? false)
      .onSet((value) => this.#setAutoMove(Boolean(value)));

    const sensorSubtype = 'automove-warning';
    const restoredSensor = this.#accessory.getServiceById(HapService.MotionSensor, sensorSubtype);
    if (warnMinutes === 0) {
      // No warning wanted, so no sensor: a motion sensor that can never report
      // motion is a thing in somebody's Home app that does nothing and cannot
      // be explained. Drop one left over from when a warning was configured.
      if (restoredSensor) {
        this.#accessory.removeService(restoredSensor);
      }
      this.#warnService = undefined;
    } else {
      this.#warnService =
        restoredSensor ??
        this.#accessory.addService(HapService.MotionSensor, 'Desk Move Soon', sensorSubtype);
      this.#name(this.#warnService, 'Desk Move Soon');
      this.#warnService.setCharacteristic(Characteristic.MotionDetected, false);
    }

    // A handset move is the snooze, and the only sign of a person this plugin
    // gets. It restarts the interval wherever the countdown had got to.
    this.#desk.on('external-move', () => {
      if (!this.#mover?.enabled) {
        return;
      }
      this.#mover.noteManualMove(Date.now());
      this.#warn(false);
      this.#publishTimer();
      this.#platform.log.debug(`${this.#config.name}: moved by hand, auto-move timer restarted`);
    });

    this.#autoTimer = setInterval(() => void this.#autoTick(), AUTO_TICK_MS);
    this.#autoTimer.unref();
  }

  #setAutoMove(on: boolean): void {
    this.#mover?.setEnabled(on);
    this.#rememberAutoMove(on);
    if (!on) {
      this.#warn(false);
    }
    // On is a full interval to run down, off is a timer that is not running.
    // Either way the slider has to follow, or it shows a countdown for an
    // automation that is not happening.
    this.#publishTimer(true);
    this.#platform.log.info(`${this.#config.name}: auto movement ${on ? 'on' : 'off'}`);
  }

  /**
   * Store the switch and the day it was switched on for.
   *
   * The day matters as much as the state: without it a restart looks like
   * somebody switching it on again, and "off for the new day" would last only
   * until the next time Homebridge came up.
   */
  #rememberAutoMove(on: boolean): void {
    this.#accessory.context.autoMove = on;
    this.#accessory.context.autoMoveDay = on ? (this.#mover?.enabledDay ?? null) : null;
    this.#platform.api.updatePlatformAccessories([this.#accessory]);
  }

  /** Raise or withdraw the warning, without waking HomeKit for no change. */
  #warn(active: boolean): void {
    const { Characteristic } = this.#platform.api.hap;
    this.#warnService?.setCharacteristic(Characteristic.MotionDetected, active);
  }

  /** Show where the countdown stands, without waking HomeKit for no change. */
  #publishTimer(force = false): void {
    const service = this.#timerService;
    const mover = this.#mover;
    if (!service || !mover) {
      return;
    }
    const percent = mover.remainingPercent();
    if (!force && percent === this.#timerShown) {
      return;
    }
    this.#timerShown = percent;
    const { Characteristic } = this.#platform.api.hap;
    service.updateCharacteristic(Characteristic.On, mover.enabled);
    service.updateCharacteristic(Characteristic.Brightness, percent);
  }

  /**
   * Collect the writes one gesture produces, and decide once.
   *
   * A Lightbulb has to have an `On`, and the Home app spends it: dragging the
   * slider to the bottom writes `Brightness` 0 *and* `On` false, because that is
   * what a light does at zero. Read separately those are two different
   * instructions — "run the timer out" and "switch auto movement off" — and
   * whichever landed last would win, which would make dragging to zero a coin
   * toss between moving the desk and stopping the automation. Read together, as
   * the one gesture they came from, they are the one thing somebody did.
   *
   * The same settle the position slider uses, for the same reason: a drag is
   * dozens of these and only the end of it was ever meant.
   */
  #takeTimerWrite(part: { on?: boolean; brightness?: number }): void {
    Object.assign(this.#timerGesture, part);

    if (this.#timerSettle) {
      clearTimeout(this.#timerSettle);
    }
    this.#timerSettle = setTimeout(() => {
      this.#timerSettle = undefined;
      const gesture = this.#timerGesture;
      this.#timerGesture = {};
      this.#applyTimerWrite(gesture);
    }, TARGET_SETTLE_MS);
    this.#timerSettle.unref();
  }

  /**
   * What that gesture meant.
   *
   * A brightness is about the countdown, so it settles the question of whether
   * auto movement is on: it is, or there would be no countdown to drag. Only a
   * gesture that is nothing *but* `On` is the switch being used as a switch.
   */
  #applyTimerWrite({ on, brightness }: { on?: boolean; brightness?: number }): void {
    const mover = this.#mover;
    if (!mover) {
      return;
    }

    if (brightness === undefined) {
      if (on !== undefined && on !== mover.enabled) {
        this.#setAutoMove(on);
      }
      return;
    }

    const wasEnabled = mover.enabled;
    if (!wasEnabled) {
      // Dragged up from a standstill. That is a switch-on, and is remembered as
      // one — #setAutoMove also puts a full interval on the clock.
      this.#setAutoMove(true);
    }

    if (!mover.inWorkingTime()) {
      // Outside the hours there is no countdown to drag: the timer waits full
      // for the next window, and a drag to zero there is not a move either.
      // The slider goes back to where it was.
      if (wasEnabled) {
        this.#platform.log.info(
          `${this.#config.name}: outside the working hours the timer does not run; ` +
            'it starts when the next window opens',
        );
      }
      this.#publishTimer(true);
      return;
    }

    if (brightness === 0) {
      if (!wasEnabled) {
        // Switched on while the slider sat at zero, because zero is what off
        // looks like. It is where this came from, not something asked for, and
        // reading it as "move now" would turn switching the automation on into
        // a desk that moves under somebody's coffee.
        this.#publishTimer(true);
        return;
      }
      const state = this.#desk.state;
      if (!state.connected || !state.ready) {
        // There is nothing to run the timer out into. Expiring anyway would
        // leave the countdown sitting at zero with auto movement still on, and
        // zero is what the slider shows when it is off — the one reading it
        // must never give while it is running. So the drag is refused and the
        // slider goes back to where the countdown actually is.
        this.#platform.log.warn(
          `${this.#config.name}: the timer was run out by hand, but the desk is not reachable`,
        );
        this.#publishTimer(true);
        return;
      }

      // Run out by hand. The warning is withdrawn rather than raised: it
      // announces a move that is coming, and this one is already here.
      this.#platform.log.info(`${this.#config.name}: timer run out by hand`);
      mover.expire();
      this.#warn(false);
      void this.#autoTick();
      return;
    }

    mover.setRemainingPercent(brightness);
    this.#platform.log.debug(
      `${this.#config.name}: timer set to ${brightness}% of the interval`,
    );
    this.#publishTimer(true);
  }

  /**
   * The half-minute tick: decide, then show where the countdown stands.
   *
   * The redraw is in a `finally` because {@link #decide} leaves by a dozen
   * doors — nothing due, outside the hours, a new day, a move — and the slider
   * has to be right after all of them. It is also the ordinary redraw, which is
   * what makes the timer visibly run down rather than jump when something
   * happens to touch it.
   */
  async #autoTick(): Promise<void> {
    if (!this.#mover) {
      return;
    }
    try {
      await this.#decide(this.#mover);
    } finally {
      this.#publishTimer();
    }
  }

  /** Ask the scheduler what it wants, and do it. */
  async #decide(mover: AutoMover): Promise<void> {
    const state = this.#desk.state;
    if (!state.connected || !state.ready) {
      return;
    }

    const action = mover.poll(new Date(), state.heightMm, state.moving !== null);
    if (action.kind === 'none') {
      return;
    }
    if (action.kind === 'warn') {
      this.#warn(true);
      this.#platform.log.info(
        `${this.#config.name}: moving in ${action.inMinutes} minutes — ` +
          'nudge the desk with the handset to put it off',
      );
      return;
    }
    if (action.kind === 'clear') {
      this.#warn(false);
      return;
    }
    if (action.kind === 'off') {
      // A new day. The switch in the Home app has to follow, or it would show
      // as on while nothing happens, which is the worst of both.
      this.#autoService?.updateCharacteristic(
        this.#platform.api.hap.Characteristic.On,
        false,
      );
      this.#warn(false);
      this.#rememberAutoMove(false);
      this.#platform.log.info(
        `${this.#config.name}: auto movement switched off for the new day; ` +
          'turn it on when you want it',
      );
      return;
    }

    this.#warn(false);
    if (state.minMm === null || state.maxMm === null) {
      return;
    }

    // The desk's own limits win, and a height outside them becomes the limit
    // rather than an error: somebody who asks to sit at 650 on a desk that
    // stops at 700 means "as low as it goes", and refusing to move at all
    // would be a strange way to honour that. Said once per height — it would
    // otherwise be in the log every half hour for as long as the setting
    // stands, which is how a log stops being read.
    const target = Math.min(Math.max(action.heightMm, state.minMm), state.maxMm);
    if (target !== action.heightMm && !this.#clamped.has(action.to)) {
      this.#clamped.add(action.to);
      this.#platform.log.info(
        `${this.#config.name}: ${action.to} is set to ${action.heightMm} mm and this desk ` +
          `travels ${state.minMm}–${state.maxMm} mm, so it will use ${target} mm`,
      );
    }

    this.#platform.log.info(`${this.#config.name}: auto movement to ${action.to}`);
    const outcome = await this.#desk.moveTo(heightToPercent(target, state.minMm, state.maxMm));
    if (outcome !== 'arrived') {
      this.#platform.log.warn(`${this.#config.name}: auto movement ended as ${outcome}`);
    }
  }

  async start(): Promise<void> {
    await this.#desk.start();
  }

  async stop(): Promise<void> {
    if (this.#targetTimer) {
      clearTimeout(this.#targetTimer);
      this.#targetTimer = undefined;
    }
    if (this.#timerSettle) {
      clearTimeout(this.#timerSettle);
      this.#timerSettle = undefined;
    }
    if (this.#autoTimer) {
      clearInterval(this.#autoTimer);
      this.#autoTimer = undefined;
    }
    await this.#desk.close();
  }

  /**
   * Record the control box's firmware version once it has told us.
   *
   * It arrives with the settings block, seconds after this accessory was
   * published, so setting it here is what keeps the value true rather than
   * what makes it visible — see the constructor, which publishes the
   * remembered one early enough for HomeKit to read it.
   *
   * The number is published as the desk reports it. A `10` is probably
   * version 1.0, but nothing here has established that, and inventing a dot
   * would turn a guess into something that looks like a reading.
   */
  #syncFirmware(state: DeskState): void {
    const { firmware } = state.settings;
    if (firmware === null || firmware === this.#firmware) {
      return;
    }
    this.#firmware = firmware;
    const { Characteristic, Service: HapService } = this.#platform.api.hap;
    this.#accessory
      .getService(HapService.AccessoryInformation)
      ?.setCharacteristic(Characteristic.FirmwareRevision, String(firmware));
    // Persisted so the next start can publish it in time to be read.
    this.#accessory.context.firmware = firmware;
    this.#platform.api.updatePlatformAccessories([this.#accessory]);
  }

  /**
   * Refuse to answer rather than answer with something stale.
   *
   * A desk that is out of range should show as "No Response", not as sitting
   * at the height it was at an hour ago — the second is indistinguishable from
   * a working desk and invites an automation to act on it.
   */
  #assertUsable(): DeskState {
    const state = this.#desk.state;
    if (!state.connected || !state.ready || state.position === null) {
      throw new this.#platform.api.hap.HapStatusError(
        this.#platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    return state;
  }

  #currentPosition(): number {
    const state = this.#assertUsable();
    return this.#snapTo ?? (state.position as number);
  }

  #targetPosition(): number {
    const state = this.#assertUsable();
    return state.target ?? (state.position as number);
  }

  #positionState(): number {
    const { PositionState } = this.#platform.api.hap.Characteristic;
    switch (this.#desk.state.moving) {
      case 'up':
        return PositionState.INCREASING;
      case 'down':
        return PositionState.DECREASING;
      default:
        return PositionState.STOPPED;
    }
  }

  /**
   * Take a target from the Home app, and wait to see whether more follow.
   *
   * A drag is dozens of these. Acting on each one means stopping the desk and
   * restarting it dozens of times, which is both slower and more likely to end
   * in a move the control box has given up on.
   */
  #setTarget(value: CharacteristicValue): void {
    this.#pendingTarget = Math.round(Number(value));
    this.#snapTo = null;

    if (this.#targetTimer) {
      clearTimeout(this.#targetTimer);
    }
    this.#targetTimer = setTimeout(() => {
      this.#targetTimer = undefined;
      const target = this.#pendingTarget;
      this.#pendingTarget = null;
      if (target !== null) {
        this.#drive(target);
      }
    }, TARGET_SETTLE_MS);
    this.#targetTimer.unref();
  }

  #drive(percent: number): void {
    // Not awaited: a full move takes half a minute and HomeKit gives a set
    // handler ten seconds. The characteristics are updated as the desk
    // reports, which is what the Home app watches anyway.
    void this.#desk
      .moveTo(percent)
      .then((outcome) => {
        if (outcome !== 'arrived' && outcome !== 'superseded') {
          this.#platform.log.warn(`${this.#config.name}: move to ${percent}% ended as ${outcome}`);
        }
      })
      .catch((error: unknown) => {
        this.#platform.log.error(`${this.#config.name}: move failed: ${String(error)}`);
      });
  }

  #onMoveEnd(outcome: MoveOutcome): void {
    const state = this.#desk.state;
    if (
      outcome === 'arrived' &&
      state.position !== null &&
      state.target !== null &&
      Math.abs(state.position - state.target) <= SNAP_TOLERANCE_PERCENT
    ) {
      this.#snapTo = state.target;
    }
  }

  /**
   * Create a switch per memory position, once the desk has told us about them.
   *
   * They cannot be built in the constructor: which memories exist is something
   * only the desk knows, and it says so a second or two after connecting. An
   * accessory restored from Homebridge's cache may already carry the services
   * from last time, which is why each one is looked up before being added.
   */
  #syncMemorySwitches(state: DeskState): void {
    if (this.#config.memorySwitches === false || !state.ready) {
      return;
    }
    const { Characteristic, Service: HapService } = this.#platform.api.hap;

    for (const slot of MEMORY_SLOTS) {
      const height = state.memories[slot - 1];
      const subtype = `memory${slot}`;
      // Already wired up in this process; nothing to do.
      if (this.#memoryServices.has(slot)) {
        continue;
      }

      const restored = this.#accessory.getServiceById(HapService.Switch, subtype);

      if (height == null) {
        // The desk has no such preset — drop a switch left over from when it
        // did, rather than leaving a button that cannot do anything.
        if (restored) {
          this.#accessory.removeService(restored);
        }
        continue;
      }

      const label = `Memory ${slot}`;
      // A restored service is reused, but its handlers are NOT: Homebridge
      // brings services back from its cache without them, because they only
      // exist at runtime. Taking the service and skipping the wiring leaves a
      // switch that is present in the Home app and does nothing when pressed.
      const service =
        restored ?? this.#accessory.addService(HapService.Switch, label, subtype);
      this.#name(service, label);
      // Momentary, not stateful. What these are for is going somewhere, and a
      // switch that stays on afterwards invites being switched off — which
      // would have to mean something, and there is no opposite of having gone
      // to a height. So it springs back, the way a scene does.
      service
        .getCharacteristic(Characteristic.On)
        .onGet(() => false)
        .onSet((value) => {
          if (!value) {
            return;
          }
          this.#setMemory(slot);
          this.#release(service);
        });
      this.#memoryServices.set(slot, service);
      this.#platform.log.info(`${this.#config.name}: memory ${slot} at ${height} mm`);
    }
  }

  /**
   * Name a service so the Home app shows it under that name.
   *
   * Both characteristics, and in this order. `Name` is what the service has
   * always carried. `ConfiguredName` is what the Home app actually displays for
   * the services of a bridged accessory — without it every switch here shows as
   * "Schalter 1", "Schalter 2" and so on — and it is also what the Home app
   * writes to when somebody renames one.
   *
   * It has to be declared before it is set: Switch, MotionSensor and
   * WindowCovering do not list `ConfiguredName` among their characteristics, so
   * setting it straight out produces "Characteristic not in required or
   * optional characteristic section" from Homebridge and an accessory HomeKit
   * treats as not quite conforming. `addOptionalCharacteristic` is the missing
   * step, not the characteristic itself.
   *
   * And it is only ever set when empty. A value already there came either from
   * a previous start or from somebody renaming the service in the Home app, and
   * there is no way to tell those apart — so the name is written once, when
   * there is nothing to overwrite, and left alone afterwards.
   */
  #name(service: Service, label: string): void {
    const { Characteristic } = this.#platform.api.hap;
    service.setCharacteristic(Characteristic.Name, label);

    service.addOptionalCharacteristic(Characteristic.ConfiguredName);
    const configured = service.getCharacteristic(Characteristic.ConfiguredName);
    const current = configured.value;
    if (current === undefined || current === null || current === '') {
      service.setCharacteristic(Characteristic.ConfiguredName, label);
    }
  }

  /** Let a momentary switch fall back to off, the way a scene button does. */
  #release(service: Service): void {
    setTimeout(() => {
      service.updateCharacteristic(this.#platform.api.hap.Characteristic.On, false);
    }, RELEASE_MS).unref();
  }

  #lockState(): boolean {
    const state = this.#assertUsable();
    if (state.locked === null) {
      throw new this.#platform.api.hap.HapStatusError(
        this.#platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    return state.locked;
  }

  #setLock(locked: boolean): void {
    void this.#desk
      .setLocked(locked)
      .then((ok) => {
        if (!ok) {
          this.#platform.log.warn(
            `${this.#config.name}: the desk did not ${locked ? 'lock' : 'unlock'}`,
          );
        }
        this.#publish(this.#desk.state);
      })
      .catch((error: unknown) => {
        this.#platform.log.error(`${this.#config.name}: child lock failed: ${String(error)}`);
      });
  }

  #setMemory(slot: number): void {
    this.#snapTo = null;
    void this.#desk
      .moveToMemory(slot)
      .then((outcome) => {
        if (outcome !== 'arrived' && outcome !== 'superseded') {
          this.#platform.log.warn(`${this.#config.name}: memory ${slot} ended as ${outcome}`);
        }
      })
      .catch((error: unknown) => {
        this.#platform.log.error(`${this.#config.name}: memory ${slot} failed: ${String(error)}`);
      });
  }

  #publish(state: DeskState): void {
    const { Characteristic } = this.#platform.api.hap;

    // Anything the desk does that we did not ask for invalidates the snap.
    if (this.#snapTo !== null && state.target !== this.#snapTo) {
      this.#snapTo = null;
    }
    if (!state.connected || !state.ready || state.position === null) {
      return;
    }

    const current = this.#snapTo ?? state.position;
    this.#service.updateCharacteristic(Characteristic.CurrentPosition, current);
    this.#service.updateCharacteristic(Characteristic.TargetPosition, state.target ?? current);
    this.#service.updateCharacteristic(Characteristic.PositionState, this.#positionState());

    if (this.#lockService && state.locked !== null) {
      this.#lockService.updateCharacteristic(Characteristic.On, state.locked);
    }

    // Momentary: they are never on except for the moment after a press, which
    // #release already takes care of.
    for (const service of this.#memoryServices.values()) {
      service.updateCharacteristic(Characteristic.On, false);
    }
  }
}
