#!/usr/bin/env node
/**
 * Does this desk move on step commands at all? THIS MOVES THE DESK.
 *
 *   npm run build && node tools/step-move-test.js <MAC>
 *
 * velocity-steps-test.js reported no movement, but every one of its runs had
 * written a setting first — so "the desk will not move" and "the setting we
 * wrote stops it moving" are not yet told apart. This writes nothing. It
 * pulses RAISE, then LOWER, on whatever the desk happens to be set to, and
 * says how far it got.
 *
 * Eight seconds each way is about 180 mm at the speed this desk has been
 * measured at, and the desk stops when the pulses stop.
 */
import { DeskLink } from '../dist/eliot/link.js';
import { Cmd, Report, readHeight } from '../dist/eliot/protocol.js';

const MAC = (process.argv[2] || '').toUpperCase();
if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(MAC)) {
  console.error('usage: node tools/step-move-test.js <MAC>');
  process.exit(1);
}

const PULSE_MS = 500;
const DURATION_MS = 8000;

const t0 = Date.now();
const say = (m) => console.log(`${String((Date.now() - t0) / 1000).padStart(7)}s ${m}`);
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: (m) => say(`ERR ${m}`) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let height = null;
const tally = new Map();
const link = new DeskLink(MAC, log);
link.on('frame', (f) => {
  tally.set(f.command, (tally.get(f.command) ?? 0) + 1);
  if (f.command === Report.HEIGHT) height = readHeight(f.params);
});
const tallyOf = (code) => tally.get(code) ?? 0;

await link.start();
await (link.connected
  ? Promise.resolve()
  : new Promise((res) => {
      const t = setTimeout(res, 60_000);
      link.once('connected', () => {
        clearTimeout(t);
        res(true);
      });
    }));
if (!link.connected) {
  console.error('nicht verbunden');
  process.exit(1);
}

await link.send(Cmd.WAKE);
await sleep(700);

/**
 * Pulse one direction, polling for height as we go.
 *
 * The box has been answering with 0x04 — position unknown — instead of a
 * height, and a desk that moves while saying nothing is indistinguishable
 * here from one that does not move at all. So this counts what came back and
 * reports the silence as silence, rather than as a distance of zero. Watching
 * the desk is what settles it, and that is the caller's job.
 */
async function push(direction, command) {
  const from = height;
  const heightsBefore = tallyOf(Report.HEIGHT);
  const quietBefore = tallyOf(0x04);
  const deadline = Date.now() + DURATION_MS;
  let tick = 0;
  while (Date.now() < deadline) {
    await link.send(command);
    // Poll every fourth pulse: the plugin's idle poll is what normally coaxes
    // a height out of this box, and a moving desk may need the same nudge.
    if (tick % 4 === 3) await link.send(Cmd.SETTINGS);
    tick += 1;
    await sleep(PULSE_MS);
  }
  await sleep(1500);

  const heights = tallyOf(Report.HEIGHT) - heightsBefore;
  const quiet = tallyOf(0x04) - quietBefore;
  say(`${direction}: ${heights} hoehen-frames, ${quiet}x 0x04 (position unbekannt)`);
  if (heights === 0) {
    say('    keine hoehenmeldung — ob er gefahren ist, kann nur das auge sagen');
    return null;
  }
  const moved = height - (from ?? height);
  say(
    `    ${from} -> ${height} mm  (${moved >= 0 ? '+' : ''}${moved} mm,` +
      ` ${(Math.abs(moved) / (DURATION_MS / 1000)).toFixed(1)} mm/s brutto)`,
  );
  return moved;
}

say(`start ${height === null ? 'hoehe unbekannt' : `${height} mm`}, es wird nichts geschrieben`);
say('BITTE HINSEHEN: faehrt der tisch waehrend der naechsten ~20 sekunden?');
const up = await push('RAISE', Cmd.RAISE);
await sleep(1000);
const down = await push('LOWER', Cmd.LOWER);

say('');
if (up === null && down === null) {
  say('der tisch hat durchgehend geschwiegen. bewegung: nur visuell zu beurteilen.');
} else if (up !== null && down !== null && Math.abs(up) < 10 && Math.abs(down) < 10) {
  say('er meldet, steht aber still — also blockiert, nicht stumm.');
} else {
  say('step-kommandos bewegen den tisch, und er meldet es auch.');
}

await link.close();
process.exit(0);
