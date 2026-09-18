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

import type { DeskConfig } from './config.ts';
import { Desk } from './eliot/desk.ts';
import type { DeskState, MoveOutcome, Transport } from './eliot/desk.ts';
import { DeskLink } from './eliot/link.ts';
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

/** The desk has four memory buttons; we mirror however many are in use. */
const MEMORY_SLOTS = [1, 2, 3, 4];

/** How long a momentary switch stays on before springing back. */
const RELEASE_MS = 1_000;

export class EliotAccessory {
  readonly #platform: EliotPlatform;
  readonly #accessory: PlatformAccessory;
  readonly #config: DeskConfig;
  readonly #desk: Desk;
  readonly #service: Service;

  /** Position to report instead of the real one, after a successful move. */
  #snapTo: number | null = null;
  /** Memory switches by slot, created lazily once the desk lists its memories. */
  readonly #memoryServices = new Map<number, Service>();

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
    });

    accessory
      .getService(HapService.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, 'Eliot')
      .setCharacteristic(Characteristic.Model, 'Smart Dongle')
      .setCharacteristic(Characteristic.SerialNumber, config.mac);

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

    this.#desk.on('change', (state) => {
      this.#syncMemorySwitches(state);
      this.#publish(state);
    });
    this.#desk.on('move-end', (outcome) => this.#onMoveEnd(outcome));
  }

  get name(): string {
    return this.#config.name;
  }

  async start(): Promise<void> {
    await this.#desk.start();
  }

  async stop(): Promise<void> {
    await this.#desk.close();
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

      const label = this.#config.memoryNames?.[slot - 1] ?? `Memory ${slot}`;
      // A restored service is reused, but its handlers are NOT: Homebridge
      // brings services back from its cache without them, because they only
      // exist at runtime. Taking the service and skipping the wiring leaves a
      // switch that is present in the Home app and does nothing when pressed.
      const service =
        restored ??
        this.#accessory.addService(HapService.Switch, `${this.#config.name} ${label}`, subtype);
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

  /** Name a service so the Home app shows it under its own name. */
  #name(service: Service, label: string): void {
    const { Characteristic } = this.#platform.api.hap;
    const full = `${this.#config.name} ${label}`;
    service.setCharacteristic(Characteristic.Name, full);
    service.setCharacteristic(Characteristic.ConfiguredName, full);
  }

  /** Let a momentary switch fall back to off, the way a scene button does. */
  #release(service: Service): void {
    setTimeout(() => {
      service.updateCharacteristic(this.#platform.api.hap.Characteristic.On, false);
    }, RELEASE_MS).unref();
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

    // Momentary: they are never on except for the moment after a press, which
    // #release already takes care of.
    for (const service of this.#memoryServices.values()) {
      service.updateCharacteristic(Characteristic.On, false);
    }
  }
}
