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
import type { DeskState, MoveOutcome } from './eliot/desk.ts';
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

export class EliotAccessory {
  readonly #platform: EliotPlatform;
  readonly #config: DeskConfig;
  readonly #desk: Desk;
  readonly #service: Service;

  /** Position to report instead of the real one, after a successful move. */
  #snapTo: number | null = null;

  constructor(platform: EliotPlatform, accessory: PlatformAccessory, config: DeskConfig) {
    this.#platform = platform;
    this.#config = config;

    const { Characteristic, Service: HapService } = platform.api.hap;

    const link = new DeskLink(config.mac, platform.log);
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

    this.#desk.on('change', (state) => this.#publish(state));
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
  }
}
