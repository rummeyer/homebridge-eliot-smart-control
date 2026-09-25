/**
 * Finding a Smart Dongle, which is harder than it sounds.
 *
 * The dongle advertises under whatever name the desk was given in the Eliot
 * app — often none at all — with a random-static address, no
 * manufacturer data and no vendor name. There is nothing in a scan list that
 * says "Eliot", so a person looking for it by eye has to guess — which is why
 * this exists and why the settings page uses it.
 *
 * The one reliable marker is the serial service, {@link SERVICE_SERIAL}. BlueZ
 * knows a device's service UUIDs but node-ble does not expose them, so they
 * are read off the D-Bus property directly, and everything still works without
 * them: a device that cannot be confirmed is reported rather than hidden.
 */
import { createBluetooth } from 'node-ble';

import { SERVICE_SERIAL, openAdapter } from './link.ts';

export interface FoundDesk {
  /** BLE address, the value that goes in the config. */
  address: string;
  /**
   * Advertised name, which is whatever the desk was called in the Eliot app.
   *
   * Not a way to find a dongle: it is set by whoever set it up, and a unit that
   * was never named advertises nothing useful at all. The service UUID is what
   * identifies one.
   */
  name: string | null;
  /** Signal strength in dBm. Null for a device BlueZ knows but has not heard. */
  rssi: number | null;
  /** Whether it advertises the serial service, so it really is one of these. */
  confirmed: boolean;
  /**
   * Whether something already holds it.
   *
   * The dongle takes one connection at a time. A desk that shows as connected
   * is almost always this plugin doing its job, but it might equally be the
   * Eliot app on a phone, and neither can be selected by the other.
   */
  connected: boolean;
}

export interface DiscoverOptions {
  /** How long to leave discovery running. */
  scanMs: number;
  /** Report everything found, not only devices that look like a desk. */
  includeUnknown: boolean;
  /** BlueZ adapter, e.g. `hci1`. Absent or empty means the first one. */
  adapter?: string;
}

export const DEFAULT_DISCOVER_OPTIONS: DiscoverOptions = {
  scanMs: 12_000,
  includeUnknown: false,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read a D-Bus property node-ble has no accessor for, without assuming it works. */
async function property<T>(device: unknown, name: string): Promise<T | null> {
  const helper = (device as { helper?: { prop(n: string): Promise<T> } }).helper;
  if (!helper?.prop) {
    return null;
  }
  try {
    return await helper.prop(name);
  } catch {
    return null;
  }
}

/**
 * Scan for desk dongles.
 *
 * Leaves discovery as it was found: the plugin may be mid-reconnect, and
 * stopping a scan it started would make that fail for no reason.
 */
export async function discoverDesks(options: Partial<DiscoverOptions> = {}): Promise<FoundDesk[]> {
  const { scanMs, includeUnknown, adapter: adapterName } = {
    ...DEFAULT_DISCOVER_OPTIONS,
    ...options,
  };
  const session = createBluetooth();

  try {
    const adapter = await openAdapter(session, adapterName);
    if (!(await adapter.isPowered())) {
      throw new Error('The Bluetooth adapter is powered off. Run: bluetoothctl power on');
    }

    const alreadyScanning = await adapter.isDiscovering();
    if (!alreadyScanning) {
      await adapter.startDiscovery();
    }
    await sleep(scanMs);

    const found: FoundDesk[] = [];
    for (const address of await adapter.devices()) {
      let device;
      try {
        device = await adapter.getDevice(address);
      } catch {
        // Devices come and go mid-scan; one that vanished is not an error.
        continue;
      }

      const uuids = (await property<string[]>(device, 'UUIDs')) ?? [];
      const confirmed = uuids.some((u) => u.toLowerCase() === SERVICE_SERIAL);
      const name = await device.getName().catch(() => null);
      if (!confirmed && !includeUnknown && !name) {
        continue;
      }

      found.push({
        address: address.toUpperCase(),
        name,
        // node-ble types RSSI as a string; BlueZ hands over an int16.
        rssi: await device
          .getRSSI()
          .then((v) => (v === null || v === undefined ? null : Number(v)))
          .catch(() => null),
        confirmed,
        connected: (await property<boolean>(device, 'Connected')) ?? false,
      });
    }

    if (!alreadyScanning) {
      await adapter.stopDiscovery().catch(() => {});
    }

    // Confirmed desks first, then whatever is loudest — a dongle across the
    // room is a worse answer than the one on this desk.
    return found.sort(
      (a, b) =>
        Number(b.confirmed) - Number(a.confirmed) || (b.rssi ?? -999) - (a.rssi ?? -999),
    );
  } finally {
    try {
      session.destroy();
    } catch {
      // Nothing useful to do if the D-Bus connection had already gone.
    }
  }
}
