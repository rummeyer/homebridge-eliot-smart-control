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

import { describeError } from '../errors.js';
import { FrameReader, encode } from './protocol.js';
import type { Frame } from './protocol.js';
import { OperationQueue } from './queue.js';

/** Lierda's serial service, as found on the Smart Dongle. */
export const SERVICE_SERIAL = '0000fe60-0000-1000-8000-00805f9b34fb';
/** Host to control box. */
export const CHAR_WRITE = '0000fe61-0000-1000-8000-00805f9b34fb';
/** Control box to host. */
export const CHAR_NOTIFY = '0000fe62-0000-1000-8000-00805f9b34fb';

/**
 * Delays between reconnect attempts; the last value repeats.
 *
 * The desk is not a lamp — nobody is waiting on it at three in the morning, and
 * a dongle that has stopped answering is usually one that needs unplugging.
 * Attempts thin out rather than hammering a device that cannot be helped.
 */
const RECONNECT_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

/** How long to scan for a dongle BlueZ has never seen. */
const DISCOVERY_TIMEOUT_MS = 30_000;

/** Consecutive failures after which the log stops being polite about it. */
const STUCK_AFTER_ATTEMPTS = 6;

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
  #retry: NodeJS.Timeout | null = null;

  constructor(mac: string, log: LinkLogger) {
    super();
    this.#mac = mac.toUpperCase();
    this.#log = log;
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
        this.#log.debug(`→ ${frame.toString('hex')}`);
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
      this.#log.info(`connected to desk ${this.#mac}`);
      this.emit('connected');
    } catch (error) {
      this.#log.debug(`connect attempt ${this.#attempts} failed: ${describeError(error)}`);
      if (this.#attempts === STUCK_AFTER_ATTEMPTS) {
        this.#log.warn(
          `desk ${this.#mac} has refused ${this.#attempts} connections. ` +
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
    const bluetooth = createBluetooth();
    this.#bluetooth = bluetooth;
    const adapter = await bluetooth.bluetooth.defaultAdapter();
    if (!(await adapter.isPowered())) {
      throw new Error('Bluetooth adapter is powered off — try: bluetoothctl power on');
    }
    this.#adapter = adapter;
  }

  #onBytes(chunk: Buffer): void {
    for (const frame of this.#reader.push(chunk)) {
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
      this.#bluetooth.destroy();
      this.#bluetooth = null;
      this.#adapter = null;
    }
  }
}
