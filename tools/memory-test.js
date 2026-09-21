#!/usr/bin/env node
/**
 * Does a single MOVE_n drive the desk all the way, or must it be repeated?
 * THIS MOVES THE DESK.
 *
 *   npm run build && node tools/memory-test.js <MAC> <1-4>
 *
 * Sends the command exactly once and then only watches, so whatever the desk
 * does afterwards is its own doing.
 */
import { DeskLink } from '../dist/eliot/link.js';
import { Cmd, Report, readHeight } from '../dist/eliot/protocol.js';

const MAC = (process.argv[2] || '').toUpperCase();
const SLOT = Number(process.argv[3]);
const MOVE = { 1: Cmd.MOVE_1, 2: Cmd.MOVE_2, 3: Cmd.MOVE_3, 4: Cmd.MOVE_4 };

if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(MAC) || !MOVE[SLOT]) {
  console.error('Usage: node tools/memory-test.js <MAC> <1-4>');
  process.exit(1);
}

const t0 = Date.now();
const stamp = () => `${String((Date.now() - t0) / 1000).padStart(6)}s`;
const say = (m) => console.log(`${stamp()} ${m}`);
const log = { debug: () => {}, info: (m) => say(`      ${m}`), warn: (m) => say(`WARN ${m}`), error: (m) => say(`ERR  ${m}`) };
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


const memories = {};
let height = null;

const link = new DeskLink(MAC, log);
link.on('frame', (f) => {
  if (f.command === Report.HEIGHT) {
    const h = readHeight(f.params);
    if (h !== height) { height = h; say(`      height ${h} mm`); }
  }
  for (const [slot, code] of [[1, Report.POSITION_1], [2, Report.POSITION_2], [3, Report.POSITION_3], [4, Report.POSITION_4]]) {
    if (f.command === code) memories[slot] = readHeight(f.params);
  }
});

await link.start();
await waitConnected(link, 60_000);
if (!link.connected) { console.error('nicht verbunden (60s)'); await link.close(); process.exit(1); }

await link.send(Cmd.WAKE); await sleep(800);
await link.send(Cmd.SETTINGS); await sleep(1200);

// The box answers SETTINGS with a height and never sends one unprompted, so
// without this the desk can drive its whole travel while this tool watches a
// height that never changes and calls it "did not move".
// Off by default, and that is the whole finding: a SETTINGS frame is a command,
// and one arriving mid-move cancels a move the control box is driving itself.
// Polling at 400 ms turned every MOVE_n into a ~10 mm nudge and looked exactly
// like a desk that had forgotten how to drive. The box streams its height while
// it drives, so there is nothing to poll for anyway. --poll=<ms> is kept only
// so the effect can be reproduced on purpose.
const POLL_MS = Number(process.argv.find((a) => a.startsWith('--poll='))?.split('=')[1] ?? 0);
const poller = setInterval(() => {
  if (POLL_MS > 0) link.send(Cmd.SETTINGS).catch(() => {});
}, POLL_MS > 0 ? POLL_MS : 3600_000);
process.on('exit', () => clearInterval(poller));

const target = memories[SLOT];
say(`memories: ${JSON.stringify(memories)}`);
say(`start ${height} mm, ziel memory ${SLOT} = ${target} mm`);

if (!target) { say('dieser speicherplatz ist nicht belegt — abbruch'); await link.close(); process.exit(1); }

say(`>>> sende MOVE_${SLOT} GENAU EINMAL und schaue nur noch zu <<<`);
await link.send(MOVE[SLOT]);

for (let i = 0; i < 40; i++) {
  await sleep(500);
}

say(`ende: ${height} mm, ziel war ${target} mm, differenz ${height - target} mm`);
say(height !== null && Math.abs(height - target) <= 15
  ? 'ERGEBNIS: ein einzelnes kommando genuegt — die controlbox faehrt selbst'
  : 'ERGEBNIS: ein einzelnes kommando genuegt NICHT — muss wiederholt werden');

await link.close();
process.exit(0);
