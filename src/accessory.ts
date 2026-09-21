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
import { DAY_NAMES, DEFAULT_AUTO_MOVE } from './config.ts';
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
  #mover: AutoMover | undefined;
  #autoTimer: NodeJS.Timeout | undefined;

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
    this.#service.setCharacteristic(Characteristic.Name, config.name);
    this.#service.setCharacteristic(Characteristic.ConfiguredName, config.name);

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
      const restored = accessory.getServiceById(HapService.Switch, subtype);
      this.#lockService =
        restored ?? accessory.addService(HapService.Switch, 'Child Lock', subtype);
      if (restored) {
        this.#unprefix(this.#lockService, 'Child Lock');
      } else {
        this.#name(this.#lockService, 'Child Lock');
      }
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
    const auto = { ...DEFAULT_AUTO_MOVE, ...config.autoMove };

    this.#mover = new AutoMover({
      sittingMm: auto.sittingMm,
      standingMm: auto.standingMm,
      intervalMinutes: auto.intervalMinutes,
      warnMinutes: auto.warnMinutes,
      windows: auto.windows,
      days: auto.days.map((d) => DAY_NAMES.indexOf(d)).filter((d) => d >= 0),
    });
    this.#mover.setEnabled(this.#accessory.context.autoMove === true);

    const switchSubtype = 'automove';
    const restoredSwitch = this.#accessory.getServiceById(HapService.Switch, switchSubtype);
    this.#autoService =
      restoredSwitch ?? this.#accessory.addService(HapService.Switch, 'Auto Movement', switchSubtype);
    if (restoredSwitch) {
      this.#unprefix(this.#autoService, 'Auto Movement');
    } else {
      this.#name(this.#autoService, 'Auto Movement');
    }
    this.#autoService
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.#mover?.enabled ?? false)
      .onSet((value) => this.#setAutoMove(Boolean(value)));

    const sensorSubtype = 'automove-warning';
    const restoredSensor = this.#accessory.getServiceById(HapService.MotionSensor, sensorSubtype);
    this.#warnService =
      restoredSensor ??
      this.#accessory.addService(HapService.MotionSensor, 'Desk Move Soon', sensorSubtype);
    if (restoredSensor) {
      this.#unprefix(this.#warnService, 'Desk Move Soon');
    } else {
      this.#name(this.#warnService, 'Desk Move Soon');
    }
    this.#warnService.setCharacteristic(Characteristic.MotionDetected, false);

    // A handset move is the snooze, and the only sign of a person this plugin
    // gets. It restarts the interval wherever the countdown had got to.
    this.#desk.on('external-move', () => {
      if (!this.#mover?.enabled) {
        return;
      }
      this.#mover.noteManualMove(Date.now());
      this.#warn(false);
      this.#platform.log.debug(`${this.#config.name}: moved by hand, auto-move timer restarted`);
    });

    this.#autoTimer = setInterval(() => void this.#autoTick(), AUTO_TICK_MS);
    this.#autoTimer.unref();
  }

  #setAutoMove(on: boolean): void {
    this.#mover?.setEnabled(on);
    this.#accessory.context.autoMove = on;
    this.#platform.api.updatePlatformAccessories([this.#accessory]);
    if (!on) {
      this.#warn(false);
    }
    this.#platform.log.info(`${this.#config.name}: auto movement ${on ? 'on' : 'off'}`);
  }

  /** Raise or withdraw the warning, without waking HomeKit for no change. */
  #warn(active: boolean): void {
    const { Characteristic } = this.#platform.api.hap;
    this.#warnService?.setCharacteristic(Characteristic.MotionDetected, active);
  }

  /** Ask the scheduler what it wants, and do it. */
  async #autoTick(): Promise<void> {
    const mover = this.#mover;
    if (!mover) {
      return;
    }
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

    this.#warn(false);
    if (state.minMm === null || state.maxMm === null) {
      return;
    }
    // The desk's own limits win. A sitting height configured below what this
    // desk will go to is not an error worth refusing over — the desk simply
    // cannot honour it, and going as low as it does is what was meant.
    if (action.heightMm < state.minMm || action.heightMm > state.maxMm) {
      this.#platform.log.warn(
        `${this.#config.name}: ${action.to} is set to ${action.heightMm} mm, outside the ` +
          `desk's ${state.minMm}–${state.maxMm} mm; going as far as it will`,
      );
    }
    this.#platform.log.info(`${this.#config.name}: auto movement to ${action.to}`);
    const outcome = await this.#desk.moveTo(
      heightToPercent(action.heightMm, state.minMm, state.maxMm),
    );
    if (outcome !== 'arrived') {
      this.#platform.log.warn(`${this.#config.name}: auto movement ended as ${outcome}`);
    }
  }

  async start(): Promise<void> {
    await this.#desk.start();
  }

  async stop(): Promise<void> {
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

  #setTarget(value: CharacteristicValue): void {
    const percent = Math.round(Number(value));
    this.#snapTo = null;

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
      if (restored) {
        this.#unprefix(service, label);
      } else {
        this.#name(service, label);
      }
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
   * Name a service, once, when it is first created.
   *
   * Only then. `ConfiguredName` is the name the *owner* edits in the Home app,
   * so writing it on every start would quietly undo their rename at the next
   * Homebridge restart — and a rename that does not survive a restart is worse
   * than no rename, because it looks like it worked.
   *
   * The name is the label alone: "Memory 1", "Child Lock". The Home app already
   * shows which accessory a switch belongs to, and in a room full of them the
   * desk's name on every button is noise.
   */
  #name(service: Service, label: string): void {
    const { Characteristic } = this.#platform.api.hap;
    service.setCharacteristic(Characteristic.Name, label);
    service.setCharacteristic(Characteristic.ConfiguredName, label);
  }

  /**
   * Drop the desk's name from a switch this plugin named in an earlier version.
   *
   * Only when the name is still exactly what that version would have written.
   * Anything else is the owner's, including a rename that happens to start with
   * the desk's name, and is left alone — the point of naming once is that the
   * name stops being ours after that.
   */
  #unprefix(service: Service, label: string): void {
    const { Characteristic } = this.#platform.api.hap;
    const old = `${this.#config.name} ${label}`;
    if (service.getCharacteristic(Characteristic.ConfiguredName).value !== old) {
      return;
    }
    service.setCharacteristic(Characteristic.Name, label);
    service.setCharacteristic(Characteristic.ConfiguredName, label);
    this.#platform.log.info(`${this.#config.name}: renamed "${old}" to "${label}"`);
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
