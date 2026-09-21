#!/usr/bin/env node
/**
 * Do GOTO_HEIGHT (0x1B) and STOP (0x2B) work on this control box?
 * THIS MOVES THE DESK.
 *
 *   npm run build && node tools/goto-stop-test.js <MAC>
 *
 * Both commands were read out of the Eliot Android app, which talks to an
 * older dongle over different characteristics. The frame layer is the same,
 * but that is an argument, not evidence — hence this.
 *
 * Brakes, in order: STOP itself if it turns out to work; a step command,
 * which is verified to cancel a control-box-driven move; and a wall clock
 * that does not care what either of them did.
 */
import { DeskLink } from '../dist/eliot/link.js';
import { Cmd, Report, encode, readHeight } from '../dist/eliot/protocol.js';

const GOTO_HEIGHT = 0x1b;
const STOP = 0x2b;

const MAC = (process.argv[2] || '').toUpperCase();
if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(MAC)) {
  console.error('Usage: node tools/goto-stop-test.js <MAC>');
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

let height = null;
let softMin = null;
let softMax = null;

const link = new DeskLink(MAC, log);
link.on('frame', (f) => {
  if (f.command === Report.HEIGHT) {
    const h = readHeight(f.params);
    if (h !== height) { height = h; say(`      ${h} mm`); }
  }
  if (f.command === Report.LIMIT_MAX) softMax = readHeight(f.params);
  if (f.command === Report.LIMIT_MIN) softMin = readHeight(f.params);
});

/** Watch until the height has held still for a while, or time runs out. */
async function settle(maxMs) {
  let last = height;
  let lastChange = Date.now();
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await sleep(250);
    if (height !== last) { last = height; lastChange = Date.now(); }
    else if (Date.now() - lastChange > 2500) return 'still';
  }
  return 'timeout';
}

await link.start();
await waitConnected(link, 60_000);
if (!link.connected) { console.error('nicht verbunden'); await link.close(); process.exit(1); }

await link.send(Cmd.WAKE); await sleep(700);
await link.send(Cmd.SETTINGS); await sleep(1000);
await link.send(Cmd.LIMITS); await sleep(1200);

say(`start ${height} mm, erlaubt ${softMin}–${softMax} mm`);

if (height === null || softMin === null || softMax === null) {
  console.error('unvollstaendiger zustand'); await link.close(); process.exit(1);
}

// ---------- Test 1: does GOTO_HEIGHT move the desk at all? ----------------
const t1 = Math.min(height + 100, softMax - 40);
if (Math.abs(t1 - height) < 40) { say('zu wenig platz nach oben'); await link.close(); process.exit(1); }

say('');
say(`TEST 1 — GOTO_HEIGHT auf ${t1} mm, ein einziges kommando`);
const f1 = encode(GOTO_HEIGHT, [(t1 >> 8) & 0xff, t1 & 0xff]);
say(`      sende ${f1.toString('hex')}`);
const before1 = height;
await link.send(GOTO_HEIGHT, [(t1 >> 8) & 0xff, t1 & 0xff]);
const r1 = await settle(30_000);
const moved1 = Math.abs(height - before1);
say(`      ${r1}: ${before1} → ${height} mm, ziel ${t1}, abweichung ${height - t1} mm`);
const gotoWorks = moved1 > 20 && Math.abs(height - t1) <= 20;
say(gotoWorks ? 'ERGEBNIS 1: GOTO_HEIGHT FUNKTIONIERT' : `ERGEBNIS 1: funktioniert NICHT (${moved1} mm bewegt)`);

if (!gotoWorks) {
  say('ohne GOTO_HEIGHT ist test 2 sinnlos — ende');
  await link.close();
  process.exit(2);
}

// ---------- Test 2: does STOP halt one? -----------------------------------
await sleep(2000);
const t2 = Math.max(height - 200, softMin + 40);
say('');
say(`TEST 2 — GOTO_HEIGHT auf ${t2} mm, nach 3s STOP`);
const before2 = height;
await link.send(GOTO_HEIGHT, [(t2 >> 8) & 0xff, t2 & 0xff]);
await sleep(3000);
const atStop = height;
say(`>>> bei ${atStop} mm: sende STOP ${encode(STOP).toString('hex')} <<<`);
await link.send(STOP);
const r2 = await settle(20_000);
const shortOf = Math.abs(height - t2);
say(`      ${r2}: gestoppt bei ${height} mm, ziel war ${t2}, also ${shortOf} mm davor`);

const stopWorks = shortOf > 40;
say(stopWorks ? 'ERGEBNIS 2: STOP FUNKTIONIERT' : 'ERGEBNIS 2: STOP wirkungslos — durchgefahren');

if (!stopWorks) {
  say('sicherheitshalber mit einem schrittkommando nachbremsen');
  await link.send(height > before2 ? Cmd.RAISE : Cmd.LOWER);
  await settle(8000);
  say(`      steht bei ${height} mm`);
}

await link.close();
process.exit(0);
