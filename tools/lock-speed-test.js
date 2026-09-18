#!/usr/bin/env node
/**
 * Does the child lock report its state, and does VELOCITY change anything?
 * THIS MOVES THE DESK, and briefly locks it.
 *
 *   npm run build && node tools/lock-speed-test.js <MAC>
 *
 * The lock is toggled and toggled back. If this exits early with the desk
 * still locked, the handset can clear it.
 */
import { DeskLink } from '../dist/eliot/link.js';
import { Cmd, Report, heightParams, readHeight } from '../dist/eliot/protocol.js';

const MAC = (process.argv[2] || '').toUpperCase();
if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(MAC)) {
  console.error('Usage: node tools/lock-speed-test.js <MAC>');
  process.exit(1);
}

const t0 = Date.now();
const stamp = () => `${String((Date.now() - t0) / 1000).padStart(6)}s`;
const say = (m) => console.log(`${stamp()} ${m}`);
const log = { debug: () => {}, info: () => {}, warn: (m) => say(`WARN ${m}`), error: (m) => say(`ERR  ${m}`) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitConnected = (l, ms) =>
  l.connected ? Promise.resolve() : new Promise((res) => {
    const t = setTimeout(res, ms); l.once('connected', () => { clearTimeout(t); res(); });
  });

let height = null;
let softMin = null;
let softMax = null;
/** Every frame, so an answer we do not expect is still seen. */
let recent = [];

const link = new DeskLink(MAC, log);
link.on('frame', (f) => {
  recent.push(`0x${f.command.toString(16).padStart(2, '0')}[${f.params.toString('hex') || '-'}]`);
  if (f.command === Report.HEIGHT) height = readHeight(f.params);
  if (f.command === Report.LIMIT_MAX) softMax = readHeight(f.params);
  if (f.command === Report.LIMIT_MIN) softMin = readHeight(f.params);
});

const collect = async (label, send, ms = 1800) => {
  recent = [];
  await send();
  await sleep(ms);
  say(`${label}: ${recent.length ? recent.join(' ') : '(keine antwort)'}`);
  return recent.slice();
};

await link.start();
await waitConnected(link, 60_000);
if (!link.connected) { console.error('nicht verbunden'); process.exit(1); }

await collect('WAKE', () => link.send(Cmd.WAKE), 800);
await collect('SETTINGS', () => link.send(Cmd.SETTINGS));
await collect('LIMITS', () => link.send(Cmd.LIMITS));
say(`hoehe ${height} mm, erlaubt ${softMin}-${softMax} mm`);

// ---------- child lock -----------------------------------------------------
say('');
say('=== KINDERSICHERUNG ===');
const q1 = await collect('abfrage (1f 01 00)', () => link.send(Cmd.LOCK, [0x00]));
await collect('umschalten (1f 01 01)', () => link.send(Cmd.LOCK, [0x01]));
const q2 = await collect('abfrage danach', () => link.send(Cmd.LOCK, [0x00]));
await collect('zurueckschalten', () => link.send(Cmd.LOCK, [0x01]));
const q3 = await collect('abfrage am ende', () => link.send(Cmd.LOCK, [0x00]));

const answered = q1.length > 0;
const changed = JSON.stringify(q1) !== JSON.stringify(q2);
say(answered
  ? `ERGEBNIS: die box antwortet auf die abfrage${changed ? ', und die antwort aendert sich beim umschalten' : ', aber die antwort aendert sich NICHT'}`
  : 'ERGEBNIS: keine antwort auf die abfrage — zustand nicht lesbar');
say(`zustand am ende identisch mit anfang: ${JSON.stringify(q1) === JSON.stringify(q3)}`);

// ---------- velocity -------------------------------------------------------
/** Drive a fixed distance and work out mm/s from the height reports. */
async function timeRun(target) {
  const from = height;
  let first = null;
  let last = null;
  const onFrame = (f) => {
    if (f.command === Report.HEIGHT) {
      const now = Date.now();
      if (first === null && Math.abs(readHeight(f.params) - from) > 3) first = now;
      if (first !== null) last = now;
    }
  };
  link.on('frame', onFrame);
  await link.send(Cmd.GOTO_HEIGHT, heightParams(target));
  let stillFor = 0;
  let prev = height;
  while (stillFor < 2500) {
    await sleep(250);
    if (height !== prev) { prev = height; stillFor = 0; } else stillFor += 250;
  }
  link.off('frame', onFrame);
  const travelled = Math.abs(height - from);
  const secs = first && last ? (last - first) / 1000 : 0;
  return { travelled, secs, speed: secs > 0 ? travelled / secs : 0 };
}

say('');
say('=== GESCHWINDIGKEIT ===');
const lo = Math.max(softMin + 40, 760);
const hi = Math.min(softMax - 40, lo + 200);

for (const value of [40, 28]) {
  await collect(`VELOCITY ${value} (13 01 ${value.toString(16)})`, () => link.send(Cmd.VELOCITY, [value]), 1200);
  const to = Math.abs(height - hi) > Math.abs(height - lo) ? hi : lo;
  const run = await timeRun(to);
  say(`  -> bei VELOCITY ${value}: ${run.travelled} mm in ${run.secs.toFixed(1)}s = ${run.speed.toFixed(1)} mm/s`);
}

await link.close();
process.exit(0);
