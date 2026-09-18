#!/usr/bin/env node
/**
 * What happens when the handset is used during a plugin move? THIS MOVES THE
 * DESK, and expects a person to push back against it.
 *
 *   npm run build && node tools/conflict-test.js <MAC>
 *
 * Drives a long way through the normal closed loop and logs every height
 * report and every outcome, so the control box's arbitration between two
 * commanders is visible afterwards.
 */
import { Desk } from '../dist/eliot/desk.js';
import { DeskLink } from '../dist/eliot/link.js';

const MAC = (process.argv[2] || '').toUpperCase();
if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(MAC)) {
  console.error('Usage: node tools/conflict-test.js <MAC>');
  process.exit(1);
}

const t0 = Date.now();
const stamp = () => `${String((Date.now() - t0) / 1000).padStart(6)}s`;
const say = (m) => console.log(`${stamp()} ${m}`);
const log = { debug: () => {}, info: (m) => say(`      ${m}`), warn: (m) => say(`WARN  ${m}`), error: (m) => say(`ERROR ${m}`) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitConnected = (l, ms) =>
  l.connected ? Promise.resolve() : new Promise((res) => {
    const t = setTimeout(res, ms);
    l.once('connected', () => { clearTimeout(t); res(); });
  });

const link = new DeskLink(MAC, log);
const desk = new Desk(link, log, { idlePollMs: 0 });

let last = null;
desk.on('change', (s) => {
  const line = `${s.heightMm} mm  ${s.position}%  ziel ${s.target}%  ${s.moving ?? 'steht'}`;
  if (line !== last) { last = line; say(`      ${line}`); }
});

await desk.start();
await waitConnected(link, 60_000);
await sleep(3000);

const s0 = desk.state;
if (!s0.ready) { console.error('kein zustand'); await desk.close(); process.exit(1); }

// A long move, well inside the limits, so there is room to fight over.
const up = s0.position < 50;
const target = up ? Math.min(s0.position + 40, 90) : Math.max(s0.position - 40, 10);
say(`start ${s0.heightMm} mm (${s0.position}%), fahre nach ${target}% — ${up ? 'HOCH' : 'RUNTER'}`);
say(`>>> JETZT AM HANDSET DIE GEGENRICHTUNG DRUECKEN: ${up ? 'RUNTER' : 'HOCH'} <<<`);

const outcome = await desk.moveTo(target);
say(`ERGEBNIS: ${outcome}`);

await sleep(3000);
const s1 = desk.state;
say(`danach: ${s1.heightMm} mm (${s1.position}%), ziel ${s1.target}%, ${s1.moving ?? 'steht'}`);
say(outcome === 'stalled'
  ? 'DEUTUNG: der regelkreis hat den widerstand erkannt und aufgegeben — gewuenscht'
  : outcome === 'arrived'
    ? 'DEUTUNG: durchgefahren — entweder wurde nicht gedrueckt, oder das plugin gewinnt'
    : `DEUTUNG: ${outcome} — siehe hoehenverlauf oben`);

await desk.close();
process.exit(0);
