/**
 * BLE transport for one Eliot Smart Dongle.
 *
 * The dongle is a serial bridge and nothing more: bytes written to `FE61` reach
 * the control box's second serial port, bytes it sends come back on `FE62`.
 * This class owns the BlueZ connection and turns that byte stream into frames,
 * so everything above it can think in commands and reports rather than in
 * buffers and reconnects.
 *
 * All GATT traffic is serialised through one queue. BlueZ returns `InProgress`,
 * or quietly drops a reply, when two D-Bus calls overlap on one characteristic.
 */
import { EventEmitter } from 'node:events';

import { createBluetooth } from 'node-ble';
import type { Adapter, Device, GattCharacteristic } from 'node-ble';

import { describeError } from '../errors.ts';
import { FrameReader, describeFrame, encode } from './protocol.ts';
import type { Frame } from './protocol.ts';
import { OperationQueue } from './queue.ts';

/** Lierda's serial service, as found on the Smart Dongle. */
export const SERVICE_SERIAL = '0000fe60-0000-1000-8000-00805f9b34fb';
/** Host to control box. */
export const CHAR_WRITE = '0000fe61-0000-1000-8000-00805f9b34fb';
/** Control box to host. */
export const CHAR_NOTIFY = '0000fe62-0000-1000-8000-00805f9b34fb';

/**
 * The adapter to use: the named one, or the first BlueZ lists.
 *
 * node-ble's own "Adapter not found" says neither which name was asked for nor
 * what there is, and both are what someone with a typo in the config needs.
 */
export async function openAdapter(
  session: ReturnType<typeof createBluetooth>,
  name?: string,
): Promise<Adapter> {
  const wanted = name?.trim();
  if (!wanted) {
    return session.bluetooth.defaultAdapter();
  }
  const present = await session.bluetooth.adapters();
  if (!present.includes(wanted)) {
    throw new Error(
      `Bluetooth adapter ${wanted} not found — this machine has ` +
        (present.length > 0 ? present.join(', ') : 'none'),
    );
  }
  return session.bluetooth.getAdapter(wanted);
}

/**
 * Delays between reconnect attempts; the last value repeats.
 *
 * Attempts thin out rather than hammering a device that cannot be helped, but
 * they stop thinning at thirty seconds. The usual reason the desk is
 * unreachable is that something else holds the dongle's single connection —
 * the Eliot app, most often — and that ends the moment the app is closed. A
 * five-minute ceiling meant the desk stayed missing for five minutes after it
 * was free again, with nothing to show for the wait; a minute was the same
 * mistake, smaller. On 22.09.2026 the app was closed at 10:50 and the desk was
 * still missing at 10:55, which is the whole argument in one observation.
 *
 * The ceiling is what somebody waits, so it is set by what they will put up
 * with rather than by what is polite to the dongle.
 */
const RECONNECT_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000];

/**
 * Log every frame in both directions, readably. Off unless `ELIOT_TRACE=1`.
 *
 * The idle poll alone is six frames every half minute, all saying what the
 * last six said, which buried everything else in the Homebridge debug log.
 * The trace is for working on the protocol, where the tools set it anyway.
 */
const TRACE = process.env.ELIOT_TRACE === '1';

/** How long to scan for a dongle BlueZ has never seen. */
const DISCOVERY_TIMEOUT_MS = 30_000;

/** Consecutive failures after which the log stops being polite about it. */
const STUCK_AFTER_ATTEMPTS = 6;

/**
 * Below this a signal is weak enough to warn about. The same line the scan on
 * the settings page draws, so the two do not disagree about one desk.
 */
export const WEAK_RSSI_DBM = -85;

/**
 * The signal for a log line: `, -66 dBm`, marked when weak, or nothing.
 *
 * Only ever the last advertisement heard before connecting. The dongle stops
 * advertising once connected, BlueZ then keeps showing that last value
 * unchanged, and the live reading of the link needs privileges Homebridge does
 * not have — so there is no average over a connection to report.
 */
export function describeSignal(rssi: number | null): string {
  return rssi === null ? '' : `, ${rssi} dBm${rssi < WEAK_RSSI_DBM ? ' (weak)' : ''}`;
}

/** Just enough logging for this class not to depend on Homebridge. */
export interface LinkLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface DeskLink {
  on(event: 'frame', listener: (frame: Frame) => void): this;
  on(event: 'connected', listener: () => void): this;
  on(event: 'disconnected', listener: () => void): this;
}

export class DeskLink extends EventEmitter {
  readonly #mac: string;
  readonly #log: LinkLogger;
  readonly #adapterName: string | undefined;
  readonly #queue = new OperationQueue();
  readonly #reader = new FrameReader();

  #bluetooth: ReturnType<typeof createBluetooth> | null = null;
  #adapter: Adapter | null = null;
  #device: Device | null = null;
  #write: GattCharacteristic | null = null;
  #notify: GattCharacteristic | null = null;
  /** Whether writes need a response, taken from the characteristic's flags. */
  #writeType: 'request' | 'command' = 'command';

  #connected = false;
  #closing = false;
  #attempts = 0;
  /** Signal of the last advertisement heard, in dBm, for the log. */
  #rssi: number | null = null;
  #retry: NodeJS.Timeout | null = null;

  /** @param adapterName BlueZ adapter, e.g. `hci1`; absent means the first one. */
  constructor(mac: string, log: LinkLogger, adapterName?: string) {
    super();
    this.#mac = mac.toUpperCase();
    this.#log = log;
    this.#adapterName = adapterName;
  }

  get connected(): boolean {
    return this.#connected;
  }

  get address(): string {
    return this.#mac;
  }

  /** Connect, and keep reconnecting until {@link close} is called. */
  async start(): Promise<void> {
    this.#closing = false;
    await this.#connect();
  }

  /** Stop for good. Safe to call when never started or already closed. */
  async close(): Promise<void> {
    this.#closing = true;
    if (this.#retry) {
      clearTimeout(this.#retry);
      this.#retry = null;
    }
    this.#queue.cancelQueued();
    await this.#teardown();
  }

  /**
   * Send a command frame.
   *
   * Resolves once the write has been handed to BlueZ, which is not the same as
   * the desk having acted on it — the control box acknowledges nothing. The
   * only evidence a command took effect is the height reports that follow, and
   * reading those is the caller's job.
   */
  async send(command: number, params: Buffer | number[] = []): Promise<void> {
    const characteristic = this.#write;
    if (!characteristic || !this.#connected) {
      throw new Error(`desk ${this.#mac} is not connected`);
    }
    const frame = encode(command, params);

    await this.#queue.run(async () => {
      try {
        await characteristic.writeValue(frame, { type: this.#writeType });
        if (TRACE) {
          this.#log.debug(describeFrame('out', command, Buffer.from(params)));
        }
      } catch (error) {
        // A write failing is how a dropped link usually announces itself; the
        // BlueZ disconnect signal can lag by seconds.
        this.#log.debug(`write failed: ${describeError(error)}`);
        this.#onDropped();
        throw error;
      }
    });
  }

  async #connect(): Promise<void> {
    if (this.#closing || this.#connected) {
      return;
    }
    this.#attempts += 1;

    try {
      await this.#openAdapter();
      const adapter = this.#adapter;
      if (!adapter) {
        throw new Error('no Bluetooth adapter');
      }

      if (!(await adapter.isDiscovering())) {
        await adapter.startDiscovery();
      }

      this.#log.debug(`waiting for ${this.#mac}`);
      const device = await adapter.waitDevice(this.#mac, DISCOVERY_TIMEOUT_MS);
      this.#device = device;
      // Read now: once connected the dongle no longer advertises.
      this.#rssi = await readSignal(device);

      await device.connect();
      const gatt = await device.gatt();
      const service = await gatt.getPrimaryService(SERVICE_SERIAL);
      const write = await service.getCharacteristic(CHAR_WRITE);
      const notify = await service.getCharacteristic(CHAR_NOTIFY);

      // Prefer an acknowledged write where the dongle offers one: an unnoticed
      // dropped command matters more here than the round trip costs.
      this.#writeType = (await write.getFlags()).includes('write') ? 'request' : 'command';

      this.#reader.reset();
      notify.on('valuechanged', (chunk: Buffer) => this.#onBytes(chunk));
      await notify.startNotifications();

      device.once('disconnect', () => {
        this.#log.info(`desk ${this.#mac} disconnected`);
        this.#onDropped();
      });

      this.#write = write;
      this.#notify = notify;
      this.#connected = true;
      this.#attempts = 0;
      this.#log.info(`connected to desk ${this.#mac}${describeSignal(this.#rssi)}`);
      if (this.#rssi !== null && this.#rssi < WEAK_RSSI_DBM) {
        this.#log.warn(
          `signal from ${this.#mac} is weak and the link may keep dropping; ` +
            'move the Homebridge host or a Bluetooth adapter closer to the desk.',
        );
      }
      this.emit('connected');
    } catch (error) {
      this.#log.debug(
        `connect attempt ${this.#attempts} failed${describeSignal(this.#rssi)}: ${describeError(error)}`,
      );
      if (this.#attempts === STUCK_AFTER_ATTEMPTS) {
        const heard = this.#rssi === null ? '' : ` It was last heard at ${this.#rssi} dBm.`;
        this.#log.warn(
          `desk ${this.#mac} has refused ${this.#attempts} connections.${heard} ` +
            'If the Eliot app is connected to it, close it — the dongle takes one ' +
            'connection at a time. Otherwise unplug the dongle for a few seconds.',
        );
      }
      await this.#teardown();
      this.#scheduleRetry();
    }
  }

  async #openAdapter(): Promise<void> {
    if (this.#adapter) {
      return;
    }
    const session = createBluetooth();
    this.#bluetooth = session;

    // dbus-next reports a bus that never came up — no socket, no permission —
    // as an `error` event on the bus rather than by rejecting anything we
    // awaited. Unhandled, an EventEmitter error event is fatal, so a host
    // without a reachable system bus would take Homebridge down instead of
    // logging one unreachable desk.
    const bus = (session.bluetooth as unknown as { dbus?: EventEmitter }).dbus;
    bus?.on('error', (error: unknown) => {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        this.#log.error(
          'No D-Bus system bus. This plugin needs BlueZ, so it only runs on Linux; ' +
            'in a container the host\'s /var/run/dbus/system_bus_socket must be mounted.',
        );
      } else {
        this.#log.debug(`D-Bus error: ${describeError(error)}`);
      }
      // Whatever it was, this session is finished. Drop it so the next attempt
      // builds a fresh one rather than reusing a dead bus.
      this.#adapter = null;
      this.#bluetooth = null;
      this.#onDropped();
    });

    const adapter = await openAdapter(session, this.#adapterName);
    if (!(await adapter.isPowered())) {
      throw new Error('Bluetooth adapter is powered off — try: bluetoothctl power on');
    }
    this.#adapter = adapter;
  }

  #onBytes(chunk: Buffer): void {
    for (const frame of this.#reader.push(chunk)) {
      // Traced as the mirror of the `→` above. Without it the trace shows
      // what was asked and never what came back, so "the desk did not answer"
      // and "the answer was not understood" look exactly alike — and the
      // second is the one that is this plugin's fault.
      if (TRACE) {
        this.#log.debug(describeFrame('in', frame.command, frame.params));
      }
      this.emit('frame', frame);
    }
  }

  /** One path for every way the link can go away, however we noticed. */
  #onDropped(): void {
    if (!this.#connected) {
      return;
    }
    this.#connected = false;
    this.emit('disconnected');
    void this.#teardown().then(() => this.#scheduleRetry());
  }

  #scheduleRetry(): void {
    if (this.#closing || this.#retry) {
      return;
    }
    const index = Math.min(this.#attempts, RECONNECT_BACKOFF_MS.length - 1);
    const delay = RECONNECT_BACKOFF_MS[index];
    this.#log.debug(`reconnecting in ${delay / 1000}s`);
    this.#retry = setTimeout(() => {
      this.#retry = null;
      void this.#connect();
    }, delay);
    this.#retry.unref();
  }

  async #teardown(): Promise<void> {
    this.#connected = false;
    // Always, not only when we were connected: a connect that failed part way
    // through may still have left bytes in the reader, and half a frame that
    // survives into the next session corrupts the first real one.
    this.#reader.reset();

    if (this.#notify) {
      await this.#notify.stopNotifications().catch(() => {});
      this.#notify.removeAllListeners('valuechanged');
      this.#notify = null;
    }
    this.#write = null;

    if (this.#device) {
      this.#device.removeAllListeners('disconnect');
      await this.#device.disconnect().catch(() => {});
      this.#device = null;
    }
    if (this.#closing && this.#bluetooth) {
      try {
        this.#bluetooth.destroy();
      } catch {
        // Already gone; nothing to release.
      }
      this.#bluetooth = null;
      this.#adapter = null;
    }
  }
}

/** The RSSI BlueZ has for a device, or null when it has not heard it. */
async function readSignal(device: Device): Promise<number | null> {
  // node-ble types RSSI as a string; BlueZ hands over an int16.
  const raw = await device.getRSSI().catch(() => null);
  const rssi = raw === null || raw === undefined ? NaN : Number(raw);
  return Number.isFinite(rssi) ? rssi : null;
}
