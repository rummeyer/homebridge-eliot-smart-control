#!/usr/bin/env node
/**
 * Standalone probe for the Eliot Smart Dongle. Plain JavaScript so it runs on
 * the Raspberry Pi with nothing but `npm install node-ble` — no build step, no
 * plugin install. The framing is duplicated from src/eliot/protocol.ts on
 * purpose: this tool has to work before there is anything to build.
 *
 *   node tools/eliot-probe.js scan [seconds]
 *   node tools/eliot-probe.js dump   <MAC>
 *   node tools/eliot-probe.js listen <MAC> [seconds]
 *   node tools/eliot-probe.js ask    <MAC>
 *   node tools/eliot-probe.js cmd    <MAC> <name> [param]
 *   node tools/eliot-probe.js raw    <MAC> <hex bytes…>
 *
 * Start with `ask`. It answers the one question the whole plugin rests on:
 * does the control box behind the dongle speak the Jiecang handset protocol?
 */
import { createBluetooth } from 'node-ble';

/**
 * Serial-over-BLE profiles a CC2541 bridge plausibly exposes, richest first.
 * Each names the characteristic we write to and the one that notifies back.
 */
const BRIDGES = [
  // Verified on an Eliot Smart Dongle: a Lierda LSD4BT-E95ALSP001 module, not
  // the CC2541 the vendor's blog describes. FE60 is Lierda's assigned service;
  // FE63 and FE64 are also write+notify and have not been identified.
  { name: 'Lierda LSD4BT (Eliot Smart Dongle)', write: '0000fe61', notify: '0000fe62' },
  { name: 'HM-10 / CC254x transparent serial', write: '0000ffe1', notify: '0000ffe1' },
  { name: 'CC254x split serial', write: '0000ffe9', notify: '0000ffe4' },
  { name: 'Nordic UART', write: '6e400002', notify: '6e400003' },
  { name: 'FFF0 serial', write: '0000fff2', notify: '0000fff1' },
  { name: 'TI serial port service', write: 'f000c0e1', notify: 'f000c0e2' },
  { name: 'Microchip transparent UART', write: '49535343-8841', notify: '49535343-1e4d' },
];

const ADDR_HANDSET = 0xf1;
const ADDR_DESK = 0xf2;
const EOM = 0x7e;

/** Commands the handset sends. Names are the ones used in docs/PROTOCOL.md. */
const COMMANDS = {
  raise: 0x01,
  lower: 0x02,
  'move-1': 0x05,
  'move-2': 0x06,
  settings: 0x07,
  range: 0x0c,
  limits: 0x20,
  'move-3': 0x27,
  'move-4': 0x28,
  wake: 0x29,
};

/** What the control box sends back, and how to read it. */
const REPORTS = {
  0x01: (p) => `height ${mm(p, 0)}${p.length > 2 ? `  (p2=0x${hex1(p[2])})` : ''}`,
  0x05: (p) => `unknown-05 ${p.toString('hex')}`,
  0x06: (p) => `unknown-06 ${p.toString('hex')}`,
  0x07: (p) => `physical range: max ${mm(p, 0)}, min ${mm(p, 2)}`,
  0x0e: (p) => `units ${p[0] === 0 ? 'cm' : 'inches'}`,
  0x17: (p) => `unknown-17 ${p.toString('hex')}`,
  0x19: (p) => `memory mode ${p[0] === 0 ? 'one-touch' : 'constant-touch'}`,
  0x1c: (p) => `unknown-1C ${p.toString('hex')}`,
  0x1d: (p) => `collision sensitivity ${['?', 'high', 'medium', 'low'][p[0]] ?? p[0]}`,
  0x1f: (p) => `unknown-1F ${p.toString('hex')}`,
  0x20: (p) => `limits set: max=${!!(p[0] & 0x01)} min=${!!(p[0] & 0x10)}`,
  0x21: (p) => `soft max ${mm(p, 0)}`,
  0x22: (p) => `soft min ${mm(p, 0)}`,
  0x23: (p) => `limit reached: ${p[0] === 1 ? 'max' : 'min'}`,
  0x25: (p) => `memory 1 = ${mm(p, 0)}`,
  0x26: (p) => `memory 2 = ${mm(p, 0)}`,
  0x27: (p) => `memory 3 = ${mm(p, 0)}`,
  0x28: (p) => `memory 4 = ${mm(p, 0)}`,
  0x40: () => 'RESET mode',
  0x92: (p) => `moving to preset (p0=0x${hex1(p[0])})`,
};

const hex1 = (b) => b.toString(16).padStart(2, '0');
const mm = (p, at) => (p.length >= at + 2 ? `${p.readUInt16BE(at)} mm` : '(short)');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function checksum(command, params) {
  let sum = command + params.length;
  for (const b of params) {
    sum += b;
  }
  return sum & 0xff;
}

function encode(command, params = []) {
  const bytes = Buffer.from(params);
  return Buffer.concat([
    Buffer.from([ADDR_HANDSET, ADDR_HANDSET, command, bytes.length]),
    bytes,
    Buffer.from([checksum(command, bytes), EOM]),
  ]);
}

/**
 * Length-driven reassembly. Not terminator-scanning: 0x7E is a legal payload
 * byte (115.0 cm is `04 7E`), so a desk at standing height would break a
 * parser that looked for the end marker.
 */
class FrameReader {
  #buffer = Buffer.alloc(0);

  push(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const frames = [];
    for (;;) {
      const frame = this.#shift();
      if (!frame) {
        break;
      }
      frames.push(frame);
    }
    return frames;
  }

  #shift() {
    while (this.#buffer.length >= 2) {
      const address = this.#buffer[0];
      if ((address !== ADDR_DESK && address !== ADDR_HANDSET) || this.#buffer[1] !== address) {
        this.#buffer = this.#buffer.subarray(1);
        continue;
      }
      if (this.#buffer.length < 4) {
        return null;
      }
      const command = this.#buffer[2];
      const length = this.#buffer[3];
      const total = 6 + length;
      if (this.#buffer.length < total) {
        return null;
      }
      const params = this.#buffer.subarray(4, 4 + length);
      const ok =
        this.#buffer[total - 1] === EOM && this.#buffer[total - 2] === checksum(command, params);
      if (!ok) {
        this.#buffer = this.#buffer.subarray(1);
        continue;
      }
      const frame = { address, command, params: Buffer.from(params) };
      this.#buffer = this.#buffer.subarray(total);
      return frame;
    }
    return null;
  }
}

function describeFrame(frame) {
  const decode = REPORTS[frame.command];
  const meaning = decode ? decode(frame.params) : `undocumented 0x${hex1(frame.command)}`;
  const raw = frame.params.length ? ` [${frame.params.toString('hex')}]` : '';
  return `${frame.address === ADDR_DESK ? 'desk' : 'handset'} 0x${hex1(frame.command)}${raw}  ${meaning}`;
}

/** Match a discovered characteristic UUID against a short prefix from BRIDGES. */
const matches = (uuid, key) =>
  key.includes('-') ? uuid.startsWith(key.slice(0, 8)) && uuid.includes(key.slice(9)) : uuid.startsWith(key);

async function withAdapter(fn) {
  const { bluetooth, destroy } = createBluetooth();
  try {
    const adapter = await bluetooth.defaultAdapter();
    if (!(await adapter.isPowered())) {
      throw new Error('Bluetooth adapter is powered off — run: bluetoothctl power on');
    }
    if (!(await adapter.isDiscovering())) {
      await adapter.startDiscovery();
    }
    return await fn(adapter);
  } finally {
    destroy();
  }
}

async function cmdScan(seconds) {
  await withAdapter(async (adapter) => {
    console.log(`Scanning for ${seconds}s …\n`);
    const seen = new Map();

    const sweep = async () => {
      for (const mac of await adapter.devices()) {
        if (seen.has(mac)) {
          continue;
        }
        const device = await adapter.getDevice(mac).catch(() => null);
        if (!device) {
          continue;
        }
        const name = await device.getName().catch(() => null);
        const rssi = await device.getRSSI().catch(() => null);
        seen.set(mac, { name, rssi });

        // TI owns the OUIs a CC2541 ships with, and the dongle's QR code is a
        // TI address — so a TI prefix is the strongest hint on offer.
        const isTI = /^(F8:30:02|54:6C:0E|A0:E6:F8|98:07:2D|2C:AB:33)/i.test(mac);
        const mark = isTI ? '  ← Texas Instruments OUI' : '';
        console.log(`  ${mac}  ${String(rssi ?? '   ').padStart(4)} dBm  ${name ?? '(no name)'}${mark}`);
      }
    };

    const until = Date.now() + seconds * 1000;
    while (Date.now() < until) {
      await sweep();
      await sleep(1000);
    }
    console.log(`\n${seen.size} devices. The dongle's MAC is on its QR code.`);
  });
}

/** Connect, walk the GATT tree, and pick the serial bridge out of it. */
async function connect(adapter, mac, { quiet = false } = {}) {
  if (!quiet) {
    console.log(`Waiting for ${mac} …`);
  }
  const device = await adapter.waitDevice(mac, 60_000);
  if (!quiet) {
    for (const [label, fn] of [['name', 'getName'], ['alias', 'getAlias'], ['paired', 'isPaired']]) {
      console.log(`  ${label}: ${await device[fn]().catch(() => '(unavailable)')}`);
    }
  }

  await device.connect();
  const gatt = await device.gatt();

  const found = [];
  for (const serviceUuid of await gatt.services()) {
    const service = await gatt.getPrimaryService(serviceUuid);
    for (const charUuid of await service.characteristics()) {
      const characteristic = await service.getCharacteristic(charUuid);
      found.push({ serviceUuid, charUuid, characteristic, flags: await characteristic.getFlags() });
    }
  }

  return { device, found };
}

/** Choose which characteristic to write to and which to listen on. */
function pickBridge(found) {
  const writable = (c) => c.flags.includes('write') || c.flags.includes('write-without-response');

  for (const bridge of BRIDGES) {
    const write = found.find((c) => matches(c.charUuid, bridge.write) && writable(c));
    const notify = found.find((c) => matches(c.charUuid, bridge.notify) && c.flags.includes('notify'));
    if (write && notify) {
      return { ...bridge, write, notify };
    }
  }

  // Nothing recognised: fall back to the first writable and the first
  // notifying characteristic, preferring a pair in the same service.
  const writes = found.filter(writable);
  const notifies = found.filter((c) => c.flags.includes('notify'));
  const pair = writes.find((w) => notifies.some((n) => n.serviceUuid === w.serviceUuid));
  const write = pair ?? writes[0];
  const notify = (pair && notifies.find((n) => n.serviceUuid === pair.serviceUuid)) ?? notifies[0];
  return write && notify ? { name: 'unrecognised, guessed', write, notify } : null;
}

async function cmdDump(mac) {
  await withAdapter(async (adapter) => {
    const { device, found } = await connect(adapter, mac);

    let service = null;
    for (const entry of found) {
      if (entry.serviceUuid !== service) {
        service = entry.serviceUuid;
        console.log(`\nService ${service}`);
      }
      console.log(`  ${entry.charUuid}  [${entry.flags.join(', ')}]`);
      if (entry.flags.includes('read')) {
        const value = await entry.characteristic.readValue().catch((e) => e.message);
        console.log(`      read: ${Buffer.isBuffer(value) ? value.toString('hex') || '(empty)' : `failed — ${value}`}`);
      }
    }

    const bridge = pickBridge(found);
    console.log(
      bridge
        ? `\nSerial bridge: ${bridge.name}\n  write  → ${bridge.write.charUuid} [${bridge.write.flags.join(', ')}]\n  notify ← ${bridge.notify.charUuid}`
        : '\nNo write/notify pair found — this is not a transparent serial bridge.',
    );

    await device.disconnect().catch(() => {});
  });
}

/** Subscribe to the bridge and print every frame, plus anything unparsed. */
async function openStream(bridge, { onFrame }) {
  const reader = new FrameReader();
  bridge.notify.characteristic.on('valuechanged', (buf) => {
    const frames = reader.push(buf);
    if (!frames.length) {
      console.log(`  [raw] ${buf.toString('hex')}`);
    }
    for (const frame of frames) {
      console.log(`  ${new Date().toISOString().slice(11, 23)}  ${describeFrame(frame)}`);
      onFrame(frame);
    }
  });
  await bridge.notify.characteristic.startNotifications();
}

async function send(bridge, bytes, label) {
  const type = bridge.write.flags.includes('write') ? 'request' : 'command';
  console.log(`→ ${label}: ${bytes.toString('hex')}`);
  await bridge.write.characteristic.writeValue(bytes, { type });
}

async function cmdListen(mac, seconds) {
  await withAdapter(async (adapter) => {
    const { device, found } = await connect(adapter, mac);
    const bridge = pickBridge(found);
    if (!bridge) {
      throw new Error('no serial bridge found — run `dump` and look at the GATT tree');
    }

    let count = 0;
    await openStream(bridge, { onFrame: () => (count += 1) });
    console.log(`\nListening for ${seconds}s on ${bridge.notify.charUuid} (${bridge.name}).`);
    console.log('Drive the desk with its handset now.\n');
    await sleep(seconds * 1000);

    console.log(`\n${count} frames decoded.`);
    await device.disconnect().catch(() => {});
  });
}

async function cmdAsk(mac) {
  await withAdapter(async (adapter) => {
    const { device, found } = await connect(adapter, mac);
    const bridge = pickBridge(found);
    if (!bridge) {
      throw new Error('no serial bridge found — run `dump` and look at the GATT tree');
    }
    console.log(`\nBridge: ${bridge.name}  write ${bridge.write.charUuid}  notify ${bridge.notify.charUuid}\n`);

    const heard = [];
    await openStream(bridge, { onFrame: (f) => heard.push(f) });

    // Read-only questions, in the order a handset asks them at startup. None
    // of these move the desk.
    for (const [name, code] of [
      ['wake', COMMANDS.wake],
      ['settings', COMMANDS.settings],
      ['range', COMMANDS.range],
      ['limits', COMMANDS.limits],
    ]) {
      await send(bridge, encode(code), name);
      await sleep(1500);
    }

    console.log('');
    if (heard.some((f) => f.address === ADDR_DESK)) {
      const kinds = [...new Set(heard.map((f) => `0x${hex1(f.command)}`))].join(', ');
      console.log(`CONFIRMED: the control box speaks the Jiecang handset protocol.`);
      console.log(`  ${heard.length} frames, report codes: ${kinds}`);
    } else {
      console.log('No F2 F2 frames came back. Either the dongle is not a transparent');
      console.log('bridge, or the framing differs. Re-run `listen` while driving the');
      console.log('desk by hand and see what appears as [raw].');
    }

    await device.disconnect().catch(() => {});
  });
}

async function cmdSend(mac, bytes, label, watchSeconds) {
  await withAdapter(async (adapter) => {
    const { device, found } = await connect(adapter, mac);
    const bridge = pickBridge(found);
    if (!bridge) {
      throw new Error('no serial bridge found — run `dump` first');
    }
    await openStream(bridge, { onFrame: () => {} });
    await send(bridge, bytes, label);
    await sleep(watchSeconds * 1000);
    await device.disconnect().catch(() => {});
  });
}

const USAGE = `Usage:
  eliot-probe scan [seconds]
  eliot-probe dump   <MAC>
  eliot-probe listen <MAC> [seconds]
  eliot-probe ask    <MAC>
  eliot-probe cmd    <MAC> <${Object.keys(COMMANDS).join('|')}> [param]
  eliot-probe raw    <MAC> <hex bytes…>`;

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const mac = (rest[0] || '').toUpperCase();
  const needsMac = () => {
    if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) {
      throw new Error(`expected a MAC address, got "${rest[0] ?? ''}"\n\n${USAGE}`);
    }
  };

  switch (mode) {
    case 'scan':
      return cmdScan(Number(rest[0] || 15));
    case 'dump':
      needsMac();
      return cmdDump(mac);
    case 'listen':
      needsMac();
      return cmdListen(mac, Number(rest[1] || 30));
    case 'ask':
      needsMac();
      return cmdAsk(mac);
    case 'cmd': {
      needsMac();
      const code = COMMANDS[rest[1]];
      if (code === undefined) {
        throw new Error(`unknown command "${rest[1]}"\n\n${USAGE}`);
      }
      const params = rest[2] === undefined ? [] : [Number(rest[2])];
      return cmdSend(mac, encode(code, params), rest[1], 5);
    }
    case 'raw': {
      needsMac();
      const bytes = Buffer.from(rest.slice(1).join('').replace(/[^0-9a-f]/gi, ''), 'hex');
      if (!bytes.length) {
        throw new Error(`no hex bytes given\n\n${USAGE}`);
      }
      return cmdSend(mac, bytes, 'raw', 5);
    }
    default:
      console.log(USAGE);
      process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`\nProbe failed: ${e.message}`);
    process.exit(1);
  });
