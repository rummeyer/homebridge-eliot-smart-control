/**
 * The accessory against a stand-in Homebridge and a stand-in desk.
 *
 * Exists for one class of bug the smoke test cannot reach: Homebridge brings
 * services back from its cache *without* their handlers, so an accessory that
 * reuses a restored service has to wire it up again. Skipping that leaves
 * switches that are present in the Home app and do nothing — which is exactly
 * what shipped in 0.2.0.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, test } from 'node:test';
import type { TestContext } from 'node:test';

import { EliotAccessory } from '../src/accessory.ts';
import type { Transport } from '../src/eliot/desk.ts';
import { Cmd, Report } from '../src/eliot/protocol.ts';
import type { Frame } from '../src/eliot/protocol.ts';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** See the note in desk.test.ts: unref'd timers alone let the run end early. */
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));
const be = (mm: number) => [(mm >> 8) & 0xff, mm & 0xff];
const frame = (command: number, params: number[]): Frame => ({
  address: 0xf2,
  command,
  params: Buffer.from(params),
});

/** Answers the startup questions with the heights measured on the real desk. */
class FakeTransport extends EventEmitter implements Transport {
  connected = true;
  sent: number[] = [];
  locked = false;
  firmware = 0x0a;
  reportsVersion = true;
  /** What the box has *stored* — not necessarily what it is running. */
  velocity = 21;
  lowPower = 1;
  motionMode = 0x00;

  async send(command: number, params?: Buffer | number[]): Promise<void> {
    this.sent.push(command);
    if (command === Cmd.SETTINGS) {
      this.emit('frame', frame(Report.HEIGHT, [...be(880), 0x07]));
      this.emit('frame', frame(Report.POSITION_1, be(801)));
      this.emit('frame', frame(Report.POSITION_2, be(1204)));
      this.emit('frame', frame(Report.POSITION_3, be(1000)));
      this.emit('frame', frame(Report.POSITION_4, be(0)));
    }
    if (command === Cmd.LOCK) {
      if (params && params[0] === 1) this.locked = !this.locked;
      this.emit('frame', frame(Report.LOCK, [this.locked ? 1 : 0]));
    }
    if (command === Cmd.LIMITS) {
      this.emit('frame', frame(Report.LIMIT_FLAGS, [0x11]));
      this.emit('frame', frame(Report.LIMIT_MAX, be(1280)));
      this.emit('frame', frame(Report.LIMIT_MIN, be(700)));
    }
    if (command === Cmd.RANGE) {
      this.emit('frame', frame(Report.RANGE, [...be(1285), ...be(642)]));
    }
    if (command === Cmd.CONNECT) {
      // An older control box may answer CONNECT without a version in the block.
      if (this.reportsVersion) {
        this.emit('frame', frame(Report.VERSION, [this.firmware]));
      }
      this.emit('frame', frame(Report.MOTION_MODE, [this.motionMode]));
      this.emit('frame', frame(Report.VELOCITY, [this.velocity]));
      this.emit('frame', frame(Report.LOW_POWER, [this.lowPower]));
    }
  }

  async start(): Promise<void> {
    this.emit('connected');
  }

  async close(): Promise<void> {
    this.connected = false;
  }
}

class FakeCharacteristic {
  handlers: Record<string, unknown> = {};
  value: unknown = null;
  onGet(fn: unknown) {
    this.handlers.get = fn;
    return this;
  }
  onSet(fn: unknown) {
    this.handlers.set = fn;
    return this;
  }
}

class FakeService {
  characteristics = new Map<string, FakeCharacteristic>();
  kind: string;
  subtype: string | undefined;
  constructor(kind: string, _displayName?: string, subtype?: string) {
    this.kind = kind;
    this.subtype = subtype;
  }
  getCharacteristic(name: unknown): FakeCharacteristic {
    const key = String(name);
    if (!this.characteristics.has(key)) {
      this.characteristics.set(key, new FakeCharacteristic());
    }
    return this.characteristics.get(key)!;
  }
  setCharacteristic(name: unknown, value: unknown) {
    this.getCharacteristic(name).value = value;
    return this;
  }
  updateCharacteristic(name: unknown, value: unknown) {
    this.getCharacteristic(name).value = value;
    return this;
  }
}

class FakeAccessory {
  /**
   * Homebridge gives every accessory an information service before a plugin
   * ever sees it, so the fake starts with one too. Without it the manufacturer
   * and model the constructor sets went nowhere, and no test noticed.
   */
  services: FakeService[] = [new FakeService('AccessoryInformation')];
  context: Record<string, unknown> = {};
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

const hap = {
  uuid: { generate: (s: string) => `uuid:${s}` },
  HapStatusError: class extends Error {},
  HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
  Service: new Proxy({}, { get: (_t, p) => String(p) }),
  Characteristic: new Proxy(
    { PositionState: { DECREASING: 0, INCREASING: 1, STOPPED: 2 } } as Record<string, unknown>,
    { get: (t, p) => (p in t ? t[String(p)] : String(p)) },
  ),
};

const platform = {
  api: {
    hap,
    // Homebridge persists an accessory's context when a plugin says it
    // changed; without this the firmware would be remembered in memory only.
    updatePlatformAccessories() {},
  },
  log: { debug() {}, info() {}, warn() {}, error() {} },
};

const config = { name: 'Schreibtisch', mac: 'E5:11:22:33:44:55' };

/**
 * Build an accessory over a fake desk and let its startup exchange finish.
 *
 * Cleanup goes through the test context so it happens even when an assertion
 * fails part way through.
 */
async function start(
  t: TestContext,
  accessory: FakeAccessory,
  options: { reportsVersion?: boolean; desk?: Record<string, unknown> } = {},
) {
  const transport = new FakeTransport();
  transport.reportsVersion = options.reportsVersion ?? true;
  const deskConfig = { ...config, ...(options.desk ?? {}) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = new EliotAccessory(
    platform as any,
    accessory as any,
    deskConfig as any,
    transport,
  );
  t.after(() => handle.stop());
  await handle.start();
  await tick(1500);
  return { handle, transport };
}

test('a fresh accessory gets a switch per set memory, wired up', async (t) => {
  const accessory = new FakeAccessory();
  await start(t, accessory);

  const switches = accessory.services.filter((s) => s.kind === 'Switch' && s.subtype !== 'childlock');
  assert.deepEqual(
    switches.map((s) => s.subtype),
    ['memory1', 'memory2', 'memory3'],
    'three set memories, and none for the unset fourth',
  );
  for (const service of switches) {
    const on = service.getCharacteristic('On');
    assert.equal(typeof on.handlers.get, 'function', `${service.subtype} has a getter`);
    assert.equal(typeof on.handlers.set, 'function', `${service.subtype} has a setter`);
  }

});

test('a switch restored from the cache is wired up again, not just adopted', async (t) => {
  // What Homebridge hands back after a restart: the service, without handlers.
  const accessory = new FakeAccessory();
  for (const slot of [1, 2, 3]) {
    accessory.addService('Switch', `Schreibtisch Memory ${slot}`, `memory${slot}`);
  }

  await start(t, accessory);

  const switches = accessory.services.filter((s) => s.kind === 'Switch' && s.subtype !== 'childlock');
  assert.equal(switches.length, 3, 'reused, not duplicated');
  for (const service of switches) {
    const on = service.getCharacteristic('On');
    assert.equal(
      typeof on.handlers.set,
      'function',
      `${service.subtype} must respond to a press after a restart`,
    );
  }

});

test('pressing a restored switch actually moves the desk', async (t) => {
  const accessory = new FakeAccessory();
  accessory.addService('Switch', 'Schreibtisch Memory 2', 'memory2');

  const { transport } = await start(t, accessory);

  const on = accessory.getServiceById('Switch', 'memory2')!.getCharacteristic('On');
  await (on.handlers.set as (v: unknown) => unknown)(true);
  await tick(200);

  assert.ok(transport.sent.includes(Cmd.MOVE_2), 'the memory command was sent');

});

test('the firmware version comes from the desk, not from a guess', async (t) => {
  const accessory = new FakeAccessory();
  const { transport } = await start(t, accessory);
  transport.firmware = 0x0d;
  await transport.send(Cmd.CONNECT);
  await tick(50);

  const info = accessory.getService('AccessoryInformation')!;
  assert.equal(info.getCharacteristic('FirmwareRevision').value, '13');
});

test('the firmware survives a restart, so HomeKit can read it in time', async (t) => {
  // HomeKit reads the information service when the bridge publishes and does
  // not come back for it. A version first heard seconds after that is correct
  // in this process and invisible in the Home app — it shows up on the next
  // start, and only if it was remembered.
  const first = new FakeAccessory();
  const { transport } = await start(t, first);
  transport.firmware = 0x0a;
  await transport.send(Cmd.CONNECT);
  await tick(50);
  assert.equal(first.context.firmware, 10, 'the version was persisted');

  const restarted = new FakeAccessory();
  restarted.context = { ...first.context };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = new EliotAccessory(
    platform as any,
    restarted as any,
    config as any,
    new FakeTransport(),
  );
  t.after(() => handle.stop());

  assert.equal(
    restarted.getService('AccessoryInformation')!.getCharacteristic('FirmwareRevision').value,
    '10',
    'set before publication, not seconds after it',
  );
});

test('a desk that reports no version is left without one', async (t) => {
  const accessory = new FakeAccessory();
  await start(t, accessory, { reportsVersion: false });

  assert.equal(
    accessory.getService('AccessoryInformation')!.getCharacteristic('FirmwareRevision').value,
    null,
    'better no version than an invented one',
  );
});

test('an unconfigured eco mode leaves the desk alone', async (t) => {
  const accessory = new FakeAccessory();
  const { transport } = await start(t, accessory);

  assert.ok(!transport.sent.includes(Cmd.LOW_POWER), 'nothing was stored');
  assert.ok(!transport.sent.includes(Cmd.VELOCITY), 'nothing was stored');
});

test('eco mode is written with the travel speed that goes with it', async (t) => {
  const accessory = new FakeAccessory();
  // The box is holding eco off at 40; the config asks for eco on.
  const { transport } = await start(t, accessory, {
    desk: { ecoMode: 'on' },
  });
  transport.lowPower = 0;
  transport.velocity = 40;
  await transport.send(Cmd.CONNECT);
  await tick(400);

  assert.ok(transport.sent.includes(Cmd.LOW_POWER), 'eco was stored');
  assert.ok(transport.sent.includes(Cmd.VELOCITY), 'the speed went with it');
});

test('"leave" writes nothing, which is the point of having it', async (t) => {
  const accessory = new FakeAccessory();
  const { transport } = await start(t, accessory, { desk: { ecoMode: 'leave' } });
  transport.lowPower = 0;
  transport.velocity = 40;
  await transport.send(Cmd.CONNECT);
  await tick(400);

  assert.ok(!transport.sent.includes(Cmd.LOW_POWER), 'the desk was left alone');
  assert.ok(!transport.sent.includes(Cmd.VELOCITY), 'the desk was left alone');
});

test('a boolean still means what it meant in 1.2.0', async (t) => {
  const accessory = new FakeAccessory();
  const { transport } = await start(t, accessory, { desk: { ecoMode: true } });
  transport.lowPower = 0;
  transport.velocity = 40;
  await transport.send(Cmd.CONNECT);
  await tick(400);

  assert.ok(transport.sent.includes(Cmd.LOW_POWER), 'true is still eco on');
});

test('a desk already holding the configured pair is not written to', async (t) => {
  const accessory = new FakeAccessory();
  const transport = new FakeTransport();
  // Eco on at 28 is exactly what ecoMode: true asks for.
  transport.lowPower = 1;
  transport.velocity = 28;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = new EliotAccessory(
    platform as any,
    accessory as any,
    { ...config, ecoMode: 'on' } as any,
    transport,
  );
  t.after(() => handle.stop());
  await handle.start();
  await tick(600);

  assert.ok(
    !transport.sent.includes(Cmd.LOW_POWER),
    'a write would prime a change for the next reset, for nothing',
  );
});

test('a switch renamed in the Home app keeps its name across a restart', async (t) => {
  // ConfiguredName is the owner's name for the switch. Writing it on every
  // start would undo their rename at the next restart, which is worse than not
  // offering renaming at all — it looks like it worked until it does not.
  const first = new FakeAccessory();
  await start(t, first);

  const renamed = first.getServiceById('Switch', 'memory1')!;
  renamed.getCharacteristic('ConfiguredName').value = 'Sitzen';

  const restarted = new FakeAccessory();
  restarted.services = first.services;
  await start(t, restarted);

  assert.equal(
    restarted.getServiceById('Switch', 'memory1')!.getCharacteristic('ConfiguredName').value,
    'Sitzen',
    'the plugin named it once, when it made it, and not since',
  );
});

test('the child lock is a stateful switch, on from the start', async (t) => {
  const accessory = new FakeAccessory();
  const { transport } = await start(t, accessory);

  const service = accessory.getServiceById('Switch', 'childlock');
  assert.ok(service, 'the switch exists without waiting for the desk');

  const on = service.getCharacteristic('On');
  assert.equal(await (on.handlers.get as () => unknown)(), false, 'reports the real state');

  await (on.handlers.set as (v: unknown) => unknown)(true);
  await tick(1200);
  assert.equal(transport.locked, true, 'the desk actually locked');
  assert.equal(await (on.handlers.get as () => unknown)(), true);

});

test('a switch for a memory the desk no longer has is taken away', async (t) => {
  const accessory = new FakeAccessory();
  // Memory 4 is unset on this desk; a stale button must not survive.
  accessory.addService('Switch', 'Schreibtisch Memory 4', 'memory4');

  await start(t, accessory);

  assert.equal(accessory.getServiceById('Switch', 'memory4'), undefined);
  assert.equal(
    accessory.services.filter((s) => s.kind === 'Switch' && s.subtype !== 'childlock').length,
    3,
  );

});
