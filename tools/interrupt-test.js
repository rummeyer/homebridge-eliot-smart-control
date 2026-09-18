#!/usr/bin/env node
/**
 * Can a memory move be interrupted, and what are FE63/FE64 for?
 * THIS MOVES THE DESK.
 *
 *   npm run build && node tools/interrupt-test.js <MAC>
 *
 * Starts a memory move, then sends one step command in the direction it is
 * already going. If the control box treats any command as a cancel — which is
 * how handsets usually behave — the desk stops well short. If it ignores it,
 * the desk arrives as normal. The step is in the same direction on purpose, so
 * a wrong guess cannot send it the other way.
 */
import { createBluetooth } from 'node-ble';
import { DeskLink } from '../dist/eliot/link.js';
import { Cmd, Report, readHeight } from '../dist/eliot/protocol.js';

const MAC = (process.argv[2] || '').toUpperCase();
if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(MAC)) {
  console.error('Usage: node tools/interrupt-test.js <MAC>');
  process.exit(1);
}

const t0 = Date.now();
const stamp = () => `${String((Date.now() - t0) / 1000).padStart(6)}s`;
const say = (m) => console.log(`${stamp()} ${m}`);
const log = { debug: () => {}, info: (m) => say(`      ${m}`), warn: (m) => say(`WARN ${m}`), error: (m) => say(`ERR  ${m}`) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitConnected = (l, ms) =>
  l.connected ? Promise.resolve() : new Promise((res) => {
    const t = setTimeout(res, ms);
    l.once('connected', () => { clearTimeout(t); res(); });
  });

const mem = {};
let height = null;

const link = new DeskLink(MAC, log);
link.on('frame', (f) => {
  if (f.command === Report.HEIGHT) {
    const h = readHeight(f.params);
    if (h !== height) { height = h; say(`      ${h} mm`); }
  }
  const slots = { [Report.POSITION_1]: 1, [Report.POSITION_2]: 2, [Report.POSITION_3]: 3, [Report.POSITION_4]: 4 };
  if (slots[f.command]) mem[slots[f.command]] = readHeight(f.params);
});

await link.start();
await waitConnected(link, 60_000);
if (!link.connected) { console.error('nicht verbunden'); await link.close(); process.exit(1); }

await link.send(Cmd.WAKE); await sleep(800);
await link.send(Cmd.SETTINGS); await sleep(1500);
say(`memories ${JSON.stringify(mem)}, jetzt ${height} mm`);

// --- pick the furthest set memory, so there is room to see an early stop ---
let slot = null, best = -1;
for (const [k, v] of Object.entries(mem)) {
  if (v > 0 && Math.abs(v - height) > best) { best = Math.abs(v - height); slot = Number(k); }
}
if (!slot || best < 80) { say('kein weit genug entferntes ziel — abbruch'); await link.close(); process.exit(1); }

const target = mem[slot];
const upward = target > height;
const step = upward ? Cmd.RAISE : Cmd.LOWER;
const start = height;
say(`TEST: memory ${slot} = ${target} mm (${upward ? 'hoch' : 'runter'}), unterbrechung nach 2.5s mit ${upward ? 'RAISE' : 'LOWER'}`);

await link.send([Cmd.MOVE_1, Cmd.MOVE_2, Cmd.MOVE_3, Cmd.MOVE_4][slot - 1]);
await sleep(2500);
const atInterrupt = height;
say(`>>> bei ${atInterrupt} mm: sende EIN ${upward ? 'RAISE' : 'LOWER'} <<<`);
await link.send(step);

for (let i = 0; i < 30; i++) await sleep(500);

const travelled = Math.abs(height - start);
const total = Math.abs(target - start);
say('');
say(`start ${start} → unterbrochen bei ${atInterrupt} → ende ${height}, ziel war ${target}`);
say(`zurückgelegt ${travelled} von ${total} mm`);
say(Math.abs(height - target) <= 20
  ? 'ERGEBNIS: NICHT unterbrechbar — der tisch ist durchgefahren'
  : 'ERGEBNIS: UNTERBRECHBAR — ein einzelnes schrittkommando stoppt die memory-fahrt');

// --- what do FE63 and FE64 have to say for themselves? ---------------------
say('');
say('=== FE63 / FE64 ===');
const { bluetooth, destroy } = createBluetooth();
try {
  const adapter = await bluetooth.defaultAdapter();
  if (!(await adapter.isDiscovering())) await adapter.startDiscovery();
  await link.close();
  await sleep(2500);
  const dev = await adapter.waitDevice(MAC, 30_000);
  await dev.connect();
  const gatt = await dev.gatt();
  const svc = await gatt.getPrimaryService('0000fe60-0000-1000-8000-00805f9b34fb');
  for (const uuid of ['0000fe63-0000-1000-8000-00805f9b34fb', '0000fe64-0000-1000-8000-00805f9b34fb']) {
    const ch = await svc.getCharacteristic(uuid);
    const flags = await ch.getFlags();
    say(`${uuid.slice(4, 8)}: [${flags.join(', ')}]`);
    if (flags.includes('read')) {
      const v = await ch.readValue().catch((e) => e.message);
      say(`   read: ${Buffer.isBuffer(v) ? v.toString('hex') || '(leer)' : v}`);
    }
    if (flags.includes('notify')) {
      ch.on('valuechanged', (b) => say(`   [notify ${uuid.slice(4, 8)}] ${b.toString('hex')}`));
      await ch.startNotifications().catch((e) => say(`   notify failed: ${e.message}`));
    }
  }
  say('20s zuhören (fahre ruhig am handset)…');
  await sleep(20_000);
  await dev.disconnect().catch(() => {});
} catch (e) {
  say(`FE63/64 fehlgeschlagen: ${e.message}`);
} finally {
  destroy();
}
process.exit(0);
