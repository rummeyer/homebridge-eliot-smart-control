#!/usr/bin/env node
/**
 * End-to-end test of Desk against real hardware. THIS MOVES THE DESK.
 *
 *   npm run build && node tools/desk-test.js <MAC> <percent> [percent…]
 *
 * Drives to each position in turn through the same path HomeKit will use, and
 * prints every state change on the way.
 */
import { Desk } from '../dist/eliot/desk.js';
import { DeskLink } from '../dist/eliot/link.js';

const MAC = (process.argv[2] || '').toUpperCase();
const TARGETS = process.argv.slice(3).map(Number);

if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(MAC) || !TARGETS.length || TARGETS.some(Number.isNaN)) {
  console.error('Usage: node tools/desk-test.js <MAC> <percent> [percent…]');
  process.exit(1);
}

const t0 = Date.now();
const stamp = () => `${String((Date.now() - t0) / 1000).padStart(6)}s`;
const say = (m) => console.log(`${stamp()} ${m}`);
const log = { debug: () => {}, info: (m) => say(`      ${m}`), warn: (m) => say(`WARN  ${m}`), error: (m) => say(`ERROR ${m}`) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `start()` resolves after the first connect attempt, successful or not — the
 * retry runs in the background. A tool that checks `connected` straight after
 * therefore reports failure whenever the first attempt misses, which it often
 * does when the dongle has just been released by something else.
 */
const waitConnected = (l, ms) =>
  l.connected
    ? Promise.resolve()
    : new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        l.once('connected', () => { clearTimeout(timer); resolve(); });
      });


const link = new DeskLink(MAC, log);
const desk = new Desk(link, log, { idlePollMs: 0 });

let last = '';
desk.on('change', (s) => {
  const line = `${s.position}% (${s.heightMm} mm) target ${s.target}% ${s.moving ?? 'at rest'}`;
  if (line !== last) {
    last = line;
    say(`      ${line}`);
  }
});

await desk.start();
await waitConnected(link, 60_000);
await sleep(2500);

if (!desk.state.connected || desk.state.position === null) {
  console.error('No usable state — is the Eliot app holding the dongle?');
  await desk.close();
  process.exit(1);
}

say(`start: ${desk.state.position}% at ${desk.state.heightMm} mm, range ${desk.minMm}-${desk.maxMm} mm`);

for (const target of TARGETS) {
  say(`==> moveTo(${target}%)`);
  const outcome = await desk.moveTo(target);
  await sleep(2500);
  const s = desk.state;
  say(`<== ${outcome}: ${s.position}% at ${s.heightMm} mm (asked ${target}%, off by ${s.position - target}%)`);
}

await desk.close();
process.exit(0);
