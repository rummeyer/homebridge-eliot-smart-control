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
  /** The parameters of the last send of each command, for the writes that carry one. */
  sentParams = new Map<number, number[]>();
  locked = false;
  firmware = 0x0a;
  reportsVersion = true;
  /** What the box has *stored* — not necessarily what it is running. */
  velocity = 21;
  lowPower = 1;
  motionMode = 0x00;
  /** What the box holds for anti-collision: 1 high, 2 medium, 3 low. */
  sensitivity = 2;

  async send(command: number, params?: Buffer | number[]): Promise<void> {
    this.sent.push(command);
    if (params) {
      this.sentParams.set(command, [...params]);
    }
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
      this.emit('frame', frame(Report.SENSITIVITY, [this.sensitivity]));
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
  /**
   * What the service is allowed to carry beyond its own list.
   *
   * Real HAP warns and carries on when a characteristic is set without being
   * declared, which is how an accessory the Home app would not fully edit got
   * shipped twice. Here it throws, so the same mistake fails a test instead.
   */
  optional = new Set<string>(['Name']);
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
  addOptionalCharacteristic(name: unknown) {
    this.optional.add(String(name));
  }
  setCharacteristic(name: unknown, value: unknown) {
    const key = String(name);
    if (key === 'ConfiguredName' && !this.optional.has(key)) {
      throw new Error(`${this.kind}: ConfiguredName set without addOptionalCharacteristic`);
    }
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

test('every service is named, under both characteristics', async (t) => {
  // ConfiguredName is the one the Home app displays for a bridged accessory's
  // services. Without it they show as "Schalter 1", "Schalter 2" and so on.
  const accessory = new FakeAccessory();
  await start(t, accessory, { desk: { autoMove: {} } });

  const expected: [string, string, string][] = [
    ['Switch', 'memory1', 'Memory 1'],
    ['Switch', 'childlock', 'Child Lock'],
    ['Switch', 'automove', 'Auto Movement'],
    ['MotionSensor', 'automove-warning', 'Desk Move Soon'],
    ['Lightbulb', 'automove-timer', 'Timer'],
  ];
  for (const [kind, subtype, label] of expected) {
    const service = accessory.getServiceById(kind, subtype)!;
    assert.equal(service.getCharacteristic('Name').value, label, `${subtype} Name`);
    assert.equal(
      service.getCharacteristic('ConfiguredName').value,
      label,
      `${subtype} ConfiguredName`,
    );
  }
});

test('a name given in the Home app is not written over', async (t) => {
  const first = new FakeAccessory();
  await start(t, first, { desk: { autoMove: {} } });

  // The Home app writes the owner's name into ConfiguredName.
  first.getServiceById('MotionSensor', 'automove-warning')!.getCharacteristic(
    'ConfiguredName',
  ).value = 'Tisch fährt gleich';

  const restarted = new FakeAccessory();
  restarted.services = first.services;
  restarted.context = { ...first.context };
  await start(t, restarted, { desk: { autoMove: {} } });

  assert.equal(
    restarted
      .getServiceById('MotionSensor', 'automove-warning')!
      .getCharacteristic('ConfiguredName').value,
    'Tisch fährt gleich',
    'the text of the notification is the owner\'s to choose',
  );
});

test('switches are named without the desk in front of them', async (t) => {
  const accessory = new FakeAccessory();
  await start(t, accessory);

  assert.equal(
    accessory.getServiceById('Switch', 'memory1')!.getCharacteristic('Name').value,
    'Memory 1',
  );
  assert.equal(
    accessory.getServiceById('Switch', 'childlock')!.getCharacteristic('Name').value,
    'Child Lock',
  );
});

test('auto movement is off until the switch is turned on', async (t) => {
  const accessory = new FakeAccessory();
  await start(t, accessory, { desk: { autoMove: {} } });

  const auto = accessory.getServiceById('Switch', 'automove');
  assert.ok(auto, 'the switch exists');
  assert.equal(await auto.getCharacteristic('On').handlers.get?.(), false);
  assert.ok(accessory.getServiceById('MotionSensor', 'automove-warning'), 'and the sensor');
});

test('the auto movement switch is remembered across a restart', async (t) => {
  const accessory = new FakeAccessory();
  await start(t, accessory, { desk: { autoMove: {} } });

  await accessory
    .getServiceById('Switch', 'automove')!
    .getCharacteristic('On')
    .handlers.set?.(true);
  assert.equal(accessory.context.autoMove, true, 'persisted for the next start');

  const restarted = new FakeAccessory();
  restarted.services = accessory.services;
  restarted.context = { ...accessory.context };
  await start(t, restarted, { desk: { autoMove: {} } });

  assert.equal(
    await restarted.getServiceById('Switch', 'automove')!.getCharacteristic('On').handlers.get?.(),
    true,
    'a standing decision, not one that resets when Homebridge does',
  );
});

test('a warning of zero means no sensor to warn with', async (t) => {
  const accessory = new FakeAccessory();
  await start(t, accessory, { desk: { autoMove: { warnMinutes: 0 } } });

  assert.ok(accessory.getServiceById('Switch', 'automove'), 'the switch is still there');
  assert.equal(
    accessory.getServiceById('MotionSensor', 'automove-warning'),
    undefined,
    'a sensor that can never report motion explains itself to nobody',
  );
});

test('a sensor from when a warning was wanted is removed', async (t) => {
  const withWarning = new FakeAccessory();
  await start(t, withWarning, { desk: { autoMove: { warnMinutes: 5 } } });
  assert.ok(withWarning.getServiceById('MotionSensor', 'automove-warning'));

  const without = new FakeAccessory();
  without.services = withWarning.services;
  await start(t, without, { desk: { autoMove: { warnMinutes: 0 } } });

  assert.equal(without.getServiceById('MotionSensor', 'automove-warning'), undefined);
});

test('a bad auto-move setting costs auto movement, not the desk', async (t) => {
  const accessory = new FakeAccessory();
  await start(t, accessory, {
    desk: { autoMove: { intervalMinutes: 30, warnMinutes: 30 } },
  });

  assert.equal(accessory.getServiceById('Switch', 'automove'), undefined, 'no auto movement');
  assert.ok(accessory.getService('WindowCovering'), 'but the desk still works');
  assert.ok(accessory.getServiceById('Switch', 'memory1'), 'and so do its presets');
});

test('no auto movement accessories unless it is configured', async (t) => {
  const accessory = new FakeAccessory();
  await start(t, accessory);

  assert.equal(accessory.getServiceById('Switch', 'automove'), undefined);
  assert.equal(accessory.getServiceById('MotionSensor', 'automove-warning'), undefined);
  assert.equal(accessory.getServiceById('Lightbulb', 'automove-timer'), undefined);
});

test('a drag is one move, not one per step of the slider', async (t) => {
  const accessory = new FakeAccessory();
  const { transport } = await start(t, accessory);
  const before = transport.sent.filter((c) => c === Cmd.GOTO_HEIGHT).length;

  // What the Home app sends while a finger is on the slider.
  const target = accessory.getService('WindowCovering')!.getCharacteristic('TargetPosition');
  for (const percent of [22, 28, 35, 44, 52, 61, 65]) {
    await target.handlers.set?.(percent);
  }
  await tick(600);

  assert.equal(
    transport.sent.filter((c) => c === Cmd.GOTO_HEIGHT).length - before,
    1,
    'seven targets, one command',
  );
});

test('a target the desk is already at is not a move', async (t) => {
  const accessory = new FakeAccessory();
  const { transport } = await start(t, accessory);
  const before = transport.sent.filter((c) => c === Cmd.GOTO_HEIGHT).length;

  // The Home app sends the current position the moment the slider is touched.
  const state = accessory.getService('WindowCovering')!;
  const now = Number(state.getCharacteristic('CurrentPosition').value);
  await state.getCharacteristic('TargetPosition').handlers.set?.(now);
  await tick(600);

  assert.equal(
    transport.sent.filter((c) => c === Cmd.GOTO_HEIGHT).length,
    before,
    'nothing was sent to the desk',
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

/**
 * Working hours that are always open, so a test can run at any hour of any day.
 *
 * The scheduler refuses to move outside its windows, which is right and which
 * would otherwise make these pass or fail depending on when they were run.
 */
const ALWAYS = {
  windows: ['00:00-23:59'],
  days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
};

test('the countdown comes with a slider, wired up both ways', async (t) => {
  const accessory = new FakeAccessory();
  await start(t, accessory, { desk: { autoMove: {} } });

  const timer = accessory.getServiceById('Lightbulb', 'automove-timer');
  assert.ok(timer, 'there is a Timer');
  for (const name of ['On', 'Brightness']) {
    const characteristic = timer.getCharacteristic(name);
    assert.equal(typeof characteristic.handlers.get, 'function', `${name} can be read`);
    assert.equal(typeof characteristic.handlers.set, 'function', `${name} can be written`);
  }
  assert.equal(
    await timer.getCharacteristic('Brightness').handlers.get?.(),
    0,
    'and it reads zero, because auto movement starts off',
  );
});

test('a slider restored from the cache is wired up again', async (t) => {
  // Homebridge hands the service back without its handlers, and a Timer that
  // cannot be dragged is worse than no Timer at all.
  const accessory = new FakeAccessory();
  accessory.addService('Lightbulb', 'Schreibtisch Timer', 'automove-timer');
  await start(t, accessory, { desk: { autoMove: {} } });

  const timers = accessory.services.filter((s) => s.kind === 'Lightbulb');
  assert.equal(timers.length, 1, 'reused, not duplicated');
  assert.equal(typeof timers[0].getCharacteristic('Brightness').handlers.set, 'function');
});

test('switching auto movement on fills the timer, and off empties it', async (t) => {
  const accessory = new FakeAccessory();
  await start(t, accessory, { desk: { autoMove: ALWAYS } });
  const auto = accessory.getServiceById('Switch', 'automove')!.getCharacteristic('On');
  const timer = accessory.getServiceById('Lightbulb', 'automove-timer')!;

  await auto.handlers.set?.(true);
  assert.equal(timer.getCharacteristic('Brightness').value, 100, 'a full interval to run down');
  assert.equal(timer.getCharacteristic('On').value, true);

  await auto.handlers.set?.(false);
  assert.equal(timer.getCharacteristic('Brightness').value, 0, 'off is a timer that is not running');
  assert.equal(timer.getCharacteristic('On').value, false);
});

test('dragging the timer to zero moves the desk, without warning about it', async (t) => {
  const accessory = new FakeAccessory();
  const { transport } = await start(t, accessory, { desk: { autoMove: ALWAYS } });
  const auto = accessory.getServiceById('Switch', 'automove')!.getCharacteristic('On');
  await auto.handlers.set?.(true);
  const before = transport.sent.filter((c) => c === Cmd.GOTO_HEIGHT).length;

  // What the Home app sends when the slider goes all the way down: a brightness
  // of zero *and* an On of false, because that is what a light does at zero.
  const timer = accessory.getServiceById('Lightbulb', 'automove-timer')!;
  await timer.getCharacteristic('Brightness').handlers.set?.(0);
  await timer.getCharacteristic('On').handlers.set?.(false);
  await tick(900);

  assert.equal(
    transport.sent.filter((c) => c === Cmd.GOTO_HEIGHT).length - before,
    1,
    'the desk was sent somewhere',
  );
  assert.equal(
    accessory
      .getServiceById('MotionSensor', 'automove-warning')!
      .getCharacteristic('MotionDetected').value,
    false,
    'and nobody was warned about a move they had just asked for',
  );
  assert.equal(
    await auto.handlers.get?.(),
    true,
    'the light going out at zero is not auto movement being switched off',
  );
  assert.equal(timer.getCharacteristic('Brightness').value, 100, 'a fresh interval starts at once');
});

test('switching the timer light off switches auto movement off', async (t) => {
  const accessory = new FakeAccessory();
  const { transport } = await start(t, accessory, { desk: { autoMove: ALWAYS } });
  const auto = accessory.getServiceById('Switch', 'automove')!.getCharacteristic('On');
  await auto.handlers.set?.(true);
  const before = transport.sent.filter((c) => c === Cmd.GOTO_HEIGHT).length;

  // A tap on the tile, which writes On and nothing else.
  const timer = accessory.getServiceById('Lightbulb', 'automove-timer')!;
  await timer.getCharacteristic('On').handlers.set?.(false);
  await tick(900);

  assert.equal(await auto.handlers.get?.(), false, 'off means off');
  assert.equal(
    transport.sent.filter((c) => c === Cmd.GOTO_HEIGHT).length - before,
    0,
    'and it is not a move',
  );
  assert.equal(timer.getCharacteristic('Brightness').value, 0);
});

test('a drag that stops short of zero only changes the wait', async (t) => {
  const accessory = new FakeAccessory();
  const { transport } = await start(t, accessory, { desk: { autoMove: ALWAYS } });
  await accessory
    .getServiceById('Switch', 'automove')!
    .getCharacteristic('On')
    .handlers.set?.(true);
  const before = transport.sent.filter((c) => c === Cmd.GOTO_HEIGHT).length;

  const timer = accessory.getServiceById('Lightbulb', 'automove-timer')!;
  // A drag is dozens of writes; only where the finger left off was meant.
  for (const percent of [92, 81, 70, 58, 50]) {
    await timer.getCharacteristic('Brightness').handlers.set?.(percent);
  }
  await tick(900);

  assert.equal(
    transport.sent.filter((c) => c === Cmd.GOTO_HEIGHT).length - before,
    0,
    'nothing moved',
  );
  assert.equal(timer.getCharacteristic('Brightness').value, 50, 'and half an interval is left');
});

test('the timer slider can be turned off in the config', async (t) => {
  const accessory = new FakeAccessory();
  // Left over from when it was wanted, which is what a restart looks like.
  accessory.addService('Lightbulb', 'Schreibtisch Timer', 'automove-timer');
  await start(t, accessory, { desk: { autoMove: { timerSlider: false } } });

  assert.equal(
    accessory.getServiceById('Lightbulb', 'automove-timer'),
    undefined,
    'a slider nobody asked for is taken away, not left doing nothing',
  );
  assert.ok(accessory.getServiceById('Switch', 'automove'), 'auto movement itself stays');
});

test('an unconfigured collision sensitivity leaves the desk alone', async (t) => {
  const accessory = new FakeAccessory();
  const { transport } = await start(t, accessory);

  assert.ok(
    !transport.sent.includes(Cmd.SENSITIVITY),
    'the box keeps whatever obstruction setting it came with',
  );
});

test('"leave" writes no sensitivity either, which is the point of having it', async (t) => {
  const accessory = new FakeAccessory();
  const { transport } = await start(t, accessory, { desk: { collisionSensitivity: 'leave' } });

  assert.ok(!transport.sent.includes(Cmd.SENSITIVITY));
});

test('a collision sensitivity that differs is stored on the desk', async (t) => {
  const accessory = new FakeAccessory();
  // The box is holding medium; the config asks for low.
  const { transport } = await start(t, accessory, { desk: { collisionSensitivity: 'low' } });
  transport.sensitivity = 2;
  await transport.send(Cmd.CONNECT);
  await tick(400);

  assert.ok(transport.sent.includes(Cmd.SENSITIVITY), 'the new setting was written');
});

test('a desk already holding the configured sensitivity is not written to', async (t) => {
  const accessory = new FakeAccessory();
  const transport = new FakeTransport();
  // Medium is exactly what the config asks for.
  transport.sensitivity = 2;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = new EliotAccessory(
    platform as any,
    accessory as any,
    { ...config, collisionSensitivity: 'medium' } as any,
    transport,
  );
  t.after(() => handle.stop());
  await handle.start();
  // Long enough for the settings block to have arrived — a shorter wait would
  // pass whether or not the plugin had ever seen what the box is holding.
  await tick(1600);

  assert.ok(
    !transport.sent.includes(Cmd.SENSITIVITY),
    'a write that changes nothing still reads in the log like something happened',
  );
});

test('the three words map onto the numbers the box uses', async (t) => {
  // High is 1 and low is 3, which runs the opposite way to how it reads.
  for (const [word, holding] of [
    ['high', 3],
    ['medium', 1],
    ['low', 1],
  ] as const) {
    const accessory = new FakeAccessory();
    const transport = new FakeTransport();
    transport.sensitivity = holding;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = new EliotAccessory(
      platform as any,
      accessory as any,
      { ...config, collisionSensitivity: word } as any,
      transport,
    );
    t.after(() => handle.stop());
    await handle.start();
    await tick(1600);

    const params = transport.sentParams.get(Cmd.SENSITIVITY);
    assert.deepEqual(params, [{ high: 1, medium: 2, low: 3 }[word]], `${word} is written`);
  }
});
