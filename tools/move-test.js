#!/usr/bin/env node
/**
 * First movement test. THIS MOVES THE DESK.
 *
 *   npm run build && node tools/move-test.js <MAC> [delta-mm]
 *
 * Reads the desk's limits, picks a target `delta` millimetres away (30 mm up by
 * default), and drives there with MoveController. Everything is logged: every
 * command sent, every frame received, and the final resting height against the
 * target, so the overshoot can be measured rather than guessed.
 *
 * Three independent brakes, in order of how much they trust:
 *   1. MoveController's own stopping conditions — the ones being tested.
 *   2. A wall-clock kill switch here, which does not care what the controller
 *      thinks. If the controller has a bug, this is what stops the desk.
 *   3. Refusing to start at all if the target is outside the desk's own soft
 *      limits, so a mistake cannot drive it into an end stop.
 */
import { DeskLink } from '../dist/eliot/link.js';
import { MoveController, heightToPercent } from '../dist/eliot/move.js';
import { Cmd, Report, readHeight } from '../dist/eliot/protocol.js';

const MAC = (process.argv[2] || '').toUpperCase();
const DELTA_MM = Number(process.argv[3] ?? 30);

/** Nothing may drive for longer than this, whatever the controller says. */
const SAFETY_MS = 25_000;
/** Keep this far clear of the soft limits when picking a target. */
const LIMIT_MARGIN_MM = 20;
/** How long to watch the desk settle after the last command. */
const SETTLE_MS = 2500;

if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(MAC) || !Number.isFinite(DELTA_MM)) {
  console.error('Usage: node tools/move-test.js <MAC> [delta-mm]');
  process.exit(1);
}

const t0 = Date.now();
const stamp = () => `${String((Date.now() - t0) / 1000).padStart(6)}s`;
const say = (m) => console.log(`${stamp()} ${m}`);
const quiet = { debug: () => {}, info: (m) => say(`      ${m}`), warn: (m) => say(`WARN  ${m}`), error: (m) => say(`ERROR ${m}`) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = { height: null, softMin: null, softMax: null, physMin: null, physMax: null };

const link = new DeskLink(MAC, quiet);
link.on('frame', (frame) => {
  switch (frame.command) {
    case Report.HEIGHT:
      state.height = readHeight(frame.params);
      break;
    case Report.LIMIT_MAX:
      state.softMax = readHeight(frame.params);
      break;
    case Report.LIMIT_MIN:
      state.softMin = readHeight(frame.params);
      break;
    case Report.RANGE:
      state.physMax = readHeight(frame.params, 0);
      state.physMin = readHeight(frame.params, 2);
      break;
    default:
      break;
  }
});

await link.start();
if (!link.connected) {
  console.error('Never connected.');
  await link.close();
  process.exit(1);
}

// --- read where we are and what we are allowed to do -----------------------
for (const command of [Cmd.WAKE, Cmd.SETTINGS, Cmd.RANGE, Cmd.LIMITS]) {
  await link.send(command);
  await sleep(900);
}

const min = state.softMin ?? state.physMin;
const max = state.softMax ?? state.physMax;
if (state.height === null || min === null || max === null) {
  console.error(`Incomplete state: ${JSON.stringify(state)}`);
  await link.close();
  process.exit(1);
}

const start = state.height;
const target = start + DELTA_MM;
say(`state: height ${start} mm, allowed ${min}-${max} mm  (${heightToPercent(start, min, max)}%)`);

if (target < min + LIMIT_MARGIN_MM || target > max - LIMIT_MARGIN_MM) {
  console.error(
    `\nRefusing: target ${target} mm is not at least ${LIMIT_MARGIN_MM} mm inside ${min}-${max}.`,
  );
  await link.close();
  process.exit(1);
}

say(`TARGET ${target} mm (${DELTA_MM > 0 ? '+' : ''}${DELTA_MM} mm) — the desk will now move`);

// --- drive -----------------------------------------------------------------
const controller = new MoveController(target, start, Date.now());
let pulses = 0;
let lastLogged = start;

const killAt = Date.now() + SAFETY_MS;
let outcome = null;

while (!outcome) {
  const now = Date.now();

  if (now > killAt) {
    outcome = 'KILL-SWITCH';
    say('KILL-SWITCH: wall clock exceeded, stopping');
    break;
  }
  if (state.height !== null && state.height !== lastLogged) {
    lastLogged = state.height;
    say(`      height ${state.height} mm`);
    controller.report(state.height, now);
  }

  const { send, result } = controller.step(now);
  if (result) {
    outcome = result;
    break;
  }
  if (send) {
    pulses += 1;
    await link.send(send === 'up' ? Cmd.RAISE : Cmd.LOWER);
  }
  await sleep(50);
}

say(`stopped sending after ${pulses} pulses — outcome: ${outcome}`);

// --- let it coast and see where it ended up --------------------------------
await sleep(SETTLE_MS);
await link.send(Cmd.SETTINGS);
await sleep(1200);

const landed = state.height;
say(`settled at ${landed} mm, target was ${target} mm  →  error ${landed - target} mm`);
say(`position now ${heightToPercent(landed, min, max)}%`);

await link.close();
process.exit(outcome === 'arrived' ? 0 : 2);
