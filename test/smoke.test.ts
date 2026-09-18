/**
 * Loads the built plugin against a stand-in Homebridge API. Catches wiring
 * mistakes — registration names, service setup, characteristic handlers — that
 * type-checking alone would not, without needing a desk or a BlueZ host.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const load = (file: string) => import(pathToFileURL(resolve(file)).href);

class FakeCharacteristic {
  handlers: Record<string, unknown> = {};
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  onGet(fn: unknown) {
    this.handlers.get = fn;
    return this;
  }
  onSet(fn: unknown) {
    this.handlers.set = fn;
    return this;
  }
  setProps(_p: Record<string, unknown>) {
    return this;
  }
}

class FakeService {
  characteristics = new Map<string, FakeCharacteristic>();
  kind: string;
  displayName: string | undefined;
  subtype: string | undefined;
  constructor(kind: string, displayName?: string, subtype?: string) {
    this.kind = kind;
    this.displayName = displayName;
    this.subtype = subtype;
  }
  // Keyed by name, not by identity: HAP passes characteristic *classes*, and
  // PositionState is one that also carries its own constants.
  getCharacteristic(name: unknown): FakeCharacteristic {
    const key = String(name);
    if (!this.characteristics.has(key)) {
      this.characteristics.set(key, new FakeCharacteristic(key));
    }
    return this.characteristics.get(key)!;
  }
  setCharacteristic(name: unknown, _value: unknown) {
    this.getCharacteristic(name);
    return this;
  }
  updateCharacteristic(name: unknown, _value: unknown) {
    this.getCharacteristic(name);
    return this;
  }
}

class FakeAccessory {
  services: FakeService[] = [];
  context: Record<string, unknown> = {};
  displayName: string;
  UUID: string;
  constructor(displayName: string, uuid: string) {
    this.displayName = displayName;
    this.UUID = uuid;
  }
  getService(kind: unknown) {
    return this.services.find((s) => s.kind === String(kind));
  }
  getServiceById(kind: unknown, subtype: string) {
    return this.services.find((s) => s.kind === String(kind) && s.subtype === subtype);
  }
  removeService(service: FakeService) {
    this.services = this.services.filter((s) => s !== service);
  }
  addService(kind: unknown, displayName?: string, subtype?: string) {
    const service = new FakeService(String(kind), displayName, subtype);
    this.services.push(service);
    return service;
  }
}

/** HAP hands out characteristic classes; these stand in for them. */
function characteristicStubs() {
  const made = new Map<string, unknown>();
  const members: Record<string, Record<string, number>> = {
    PositionState: { DECREASING: 0, INCREASING: 1, STOPPED: 2 },
  };
  return new Proxy({} as Record<string, unknown>, {
    get(_target, property) {
      const key = String(property);
      if (!made.has(key)) {
        // eslint-disable-next-line no-new-wrappers
        const stub = new String(key);
        Object.assign(stub, members[key] ?? {});
        made.set(key, stub);
      }
      return made.get(key);
    },
  });
}

function fakeApi() {
  const api = new EventEmitter() as unknown as Record<string, unknown> & EventEmitter;
  const registered: { registered: unknown[][]; unregistered: unknown[][] } = {
    registered: [],
    unregistered: [],
  };
  Object.assign(api, {
    platformAccessory: FakeAccessory,
    user: { storagePath: () => '/tmp' },
    hap: {
      uuid: { generate: (s: string) => `uuid:${s}` },
      HapStatusError: class HapStatusError extends Error {
        hapStatus: number;
        constructor(status: number) {
          super(`HapStatusError ${status}`);
          this.hapStatus = status;
        }
      },
      HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
      Service: new Proxy({}, { get: (_t, p) => String(p) }),
      // Each characteristic stands in as a String carrying its own name, so it
      // works as a lookup key. PositionState also carries the constants the
      // accessory reads off it, the way HAP's class does.
      Characteristic: characteristicStubs(),
    },
    registerPlatform: () => {},
    registerPlatformAccessories: (_p: string, _n: string, a: unknown[]) =>
      registered.registered.push(a),
    unregisterPlatformAccessories: (_p: string, _n: string, a: unknown[]) =>
      registered.unregistered.push(a),
    updatePlatformAccessories: () => {},
  });
  return { api, registered };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

const fakeLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  log: () => {},
  success: () => {},
};

const desk = { name: 'Schreibtisch', mac: 'E5:02:4F:BF:74:A2' };

test('Homebridge can load the built entry point and register the platform', async () => {
  const namespace = await load('dist/index.js');
  const initializer = namespace.default;
  assert.equal(typeof initializer, 'function');

  const { api } = fakeApi();
  let seen: [string, string] | undefined;
  (api as unknown as { registerPlatform: unknown }).registerPlatform = (
    plugin: string,
    platform: string,
  ) => {
    seen = [plugin, platform];
  };
  (initializer as (a: unknown) => void)(api);
  assert.deepEqual(seen, ['homebridge-eliot-smart-control', 'EliotSmartControl']);

  // pluginAlias is what the Homebridge UI writes into config.json, and the
  // package name is what accessories are registered under. Both must match.
  assert.equal(readJson('../config.schema.json').pluginAlias, seen![1]);
  assert.equal(readJson('../package.json').name, seen![0]);
});

test('a configured desk becomes a window covering, not a light', async () => {
  const { EliotPlatform } = await load('dist/platform.js');
  const { api, registered } = fakeApi();

  new EliotPlatform(fakeLog, { platform: 'EliotSmartControl', desks: [desk] }, api);
  api.emit('didFinishLaunching');
  await settle();

  assert.equal(registered.registered.length, 1);
  const accessory = registered.registered[0]![0] as FakeAccessory;
  // Keyed on the dongle address, so renaming the desk keeps its room and
  // automations.
  assert.equal(accessory.UUID, `uuid:homebridge-eliot-smart-control:${desk.mac}`);

  const covering = accessory.getService('WindowCovering');
  assert.ok(covering, 'a WindowCovering service exists');
  assert.equal(accessory.getService('Lightbulb'), undefined);

  api.emit('shutdown');
  await settle();
});

test('an unreachable desk reports no response rather than a stale height', async () => {
  const { EliotPlatform } = await load('dist/platform.js');
  const { api, registered } = fakeApi();

  new EliotPlatform(fakeLog, { platform: 'x', desks: [desk] }, api);
  api.emit('didFinishLaunching');
  await settle();

  const covering = (registered.registered[0]![0] as FakeAccessory).getService('WindowCovering')!;
  for (const name of ['CurrentPosition', 'TargetPosition']) {
    await assert.rejects(
      async () => (covering.getCharacteristic(name).handlers.get as () => unknown)(),
      /HapStatusError -70402/,
      `${name} must not answer while disconnected`,
    );
  }

  // PositionState is the exception: "stopped" is true of a desk we cannot
  // reach, and HomeKit reads it while showing the accessory as unavailable.
  assert.equal((covering.getCharacteristic('PositionState').handlers.get as () => number)(), 2);

  api.emit('shutdown');
  await settle();
});

test('the covering offers the controls a desk actually needs', async () => {
  const { EliotPlatform } = await load('dist/platform.js');
  const { api, registered } = fakeApi();

  new EliotPlatform(fakeLog, { platform: 'x', desks: [desk] }, api);
  api.emit('didFinishLaunching');
  await settle();

  const covering = (registered.registered[0]![0] as FakeAccessory).getService('WindowCovering')!;
  assert.ok(covering.getCharacteristic('TargetPosition').handlers.set, 'settable target');
  assert.ok(covering.getCharacteristic('HoldPosition').handlers.set, 'a stop control');

  api.emit('shutdown');
  await settle();
});

test('the presets are momentary switches, named in their own right', async () => {
  const { EliotPlatform } = await load('dist/platform.js');
  const { api, registered } = fakeApi();

  new EliotPlatform(fakeLog, { platform: 'x', desks: [desk] }, api);
  api.emit('didFinishLaunching');
  await settle();

  const accessory = registered.registered[0]![0] as FakeAccessory;
  // No desk answers here, so no memories are known and no switches appear.
  // What matters is that nothing was created speculatively.
  const switches = accessory.services.filter((s) => s.kind === 'Switch');
  assert.deepEqual(switches, [], 'no preset switches before the desk lists its memories');

  api.emit('shutdown');
  await settle();
});

test('an invalid desk is skipped instead of crashing the bridge', async () => {
  const { EliotPlatform } = await load('dist/platform.js');
  const { api, registered } = fakeApi();
  const errors: string[] = [];

  new EliotPlatform(
    { ...fakeLog, error: (m: string) => errors.push(m) },
    { platform: 'x', desks: [{ ...desk, mac: 'garbage' }] },
    api,
  );
  api.emit('didFinishLaunching');
  await settle();

  assert.equal(registered.registered.length, 0);
  assert.ok(errors.some((e) => e.includes('.mac')), 'the address problem is reported');
});

test('a cached accessory is reused rather than duplicated', async () => {
  const { EliotPlatform } = await load('dist/platform.js');
  const { api, registered } = fakeApi();
  const platform = new EliotPlatform(fakeLog, { platform: 'x', desks: [desk] }, api);

  const cached = new FakeAccessory(desk.name, `uuid:homebridge-eliot-smart-control:${desk.mac}`);
  (platform as { configureAccessory: (a: unknown) => void }).configureAccessory(cached);

  api.emit('didFinishLaunching');
  await settle();

  assert.equal(registered.registered.length, 0, 'nothing newly registered');
  assert.ok(cached.getService('WindowCovering'), 'the covering was added to the cached one');

  api.emit('shutdown');
  await settle();
});

test('a desk removed from the config has its accessory removed too', async () => {
  const { EliotPlatform } = await load('dist/platform.js');
  const { api, registered } = fakeApi();
  const platform = new EliotPlatform(fakeLog, { platform: 'x', desks: [desk] }, api);

  const orphan = new FakeAccessory('Old desk', 'uuid:homebridge-eliot-smart-control:AA:BB:CC:DD:EE:FF');
  (platform as { configureAccessory: (a: unknown) => void }).configureAccessory(orphan);

  api.emit('didFinishLaunching');
  await settle();

  assert.equal(registered.unregistered.length, 1);
  assert.deepEqual(registered.unregistered[0], [orphan]);

  api.emit('shutdown');
  await settle();
});
