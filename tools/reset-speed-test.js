#!/usr/bin/env node
/**
 * Do VELOCITY and LOW_POWER bite once the desk has been reset? THIS MOVES THE DESK.
 *
 *   npm run build
 *   node tools/reset-speed-test.js <MAC> --phase=1 --eco=off --velocity=40
 *   ...reset the desk by hand...
 *   node tools/reset-speed-test.js <MAC> --phase=2
 *
 * Everything before this measured the two settings without a reset and found
 * nothing: VELOCITY 40 against 28 gave 22.6, 22.4, 22.4 mm/s, and LOW_POWER
 * off/on/off gave 22.2, 22.4, 22.6. settings-write-test.js then showed the
 * writes really are stored, so the box was not dropping them — it was ignoring
 * them until reset, which is what the app warns about when either is changed.
 *
 * There is no reset command. The app's *Automatischer Reset* drives the desk to
 * its physical bottom so the control box can find its zero again; nothing on
 * this port asks for that. So the reset is yours to perform, and this tool
 * brackets it in two phases: phase 1 sets the pair, measures the desk as it is
 * and lets go of the dongle; phase 2 measures again afterwards. Two processes
 * rather than one prompt, because the dongle takes a single connection and
 * whatever performs the reset needs it — and because the reset may come
 * minutes or hours later.
 *
 * Two things it does that the earlier tools did not:
 *
 *   - It re-reads the settings block *after* the reset. Whatever performs the
 *     reset may have been the app, and the app writes the phone's stored
 *     configuration to the desk whenever it connects — this desk went 21 → 40
 *     → 35 → 21 that way, untouched by anything else. A run scored on a
 *     setting that the app quietly replaced would be worse than no run.
 *   - It times the climb twice, once on repeated RAISE and once on
 *     GOTO_HEIGHT. The earlier finding was that the control box runs its own
 *     ramp for GOTO_HEIGHT and ignores VELOCITY there. GOTO_HEIGHT is how this
 *     plugin moves the desk, so if a reset does not change that, the setting is
 *     worth nothing to HomeKit however well it works on the handset. That
 *     distinction decides whether the setting is worth exposing at all.
 *
 * Method is deliberately the same as tools/velocity-steps-test.js, so the
 * numbers can be set beside the ones already recorded: same direction, same
 * 220 mm, and only the middle 60% timed so neither ramp flatters a setting.
 *
 * Brakes: the step climb stops the moment the pulses stop, so dying is safe.
 * On top of that both climbs have a wall clock and a height ceiling, and
 * GOTO_HEIGHT is given a target below the desk's maximum.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { DeskLink } from '../dist/eliot/link.js';
import { Cmd, Report, heightParams, readHeight } from '../dist/eliot/protocol.js';

const MAC = (process.argv[2] || '').toUpperCase();
const args = process.argv.slice(3);
const arg = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

const ecoArg = arg('eco');
const velocityArg = Number(arg('velocity'));
const PHASE = Number(arg('phase'));

if (![0, 1, 2].includes(PHASE) || !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(MAC)) {
  console.error('usage:');
  console.error('  node tools/reset-speed-test.js <MAC> --phase=0');
  console.error('    measure only: changes nothing, writes nothing');
  console.error('  node tools/reset-speed-test.js <MAC> --phase=1 --eco=on|off --velocity=<n>');
  console.error('  ...reset the desk by hand...');
  console.error('  node tools/reset-speed-test.js <MAC> --phase=2');
  console.error('  the app offers velocity 28, 31, 35, 38, 40; this desk was found on 21');
  process.exit(1);
}
if (PHASE === 1 && (!['on', 'off'].includes(ecoArg) || !Number.isInteger(velocityArg))) {
  console.error('phase 1 braucht --eco=on|off und --velocity=<n>');
  process.exit(1);
}
const ECO = ecoArg === 'on' ? 1 : 0;

/**
 * Where phase 1 leaves what phase 2 needs.
 *
 * The two halves cannot be one process: between them the dongle has to be free
 * for whatever performs the reset, and the desk may be reset minutes or hours
 * later. So the pre-reset numbers go to disk rather than being held open.
 */
const STATE = new URL('../.reset-speed-state.json', import.meta.url).pathname;

/** The same 220 mm the earlier runs used, so the numbers can be compared. */
const LOW = 780;
const HIGH = 1000;
/** Stop pulsing this far below HIGH; the desk coasts ~17 mm going up. */
const APPROACH_MM = 20;
/** The handset's own cadence. */
const PULSE_MS = 500;
/** No climb can legitimately take this long: 220 mm at 22 mm/s is 10 s. */
const CLIMB_LIMIT_MS = 45_000;
/**
 * How often to ask the box where it is, while it is being step-driven.
 *
 * The box streams its height whenever it drives itself — `GOTO_HEIGHT`, a
 * memory position — and says nothing at all while it is being walked up by
 * repeated `RAISE`. So a stepped climb has to be polled or it is measured
 * blind, and a box-driven one must **not** be: a `SETTINGS` frame is a command,
 * and one arriving mid-move cancels the move. Polling through a `GOTO_HEIGHT`
 * turns it into a ~10 mm nudge, which looks precisely like a control box that
 * refuses to drive itself, and cost an afternoon to tell apart from one.
 */
const POLL_MS = 400;

const t0 = Date.now();
const say = (m) => console.log(`${String((Date.now() - t0) / 1000).padStart(7)}s ${m}`);
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: (m) => say(`ERR ${m}`) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let height = null;
let link = null;
let poller = null;

/** Keep asking where the desk is, for as long as this process drives it. */
function startPolling() {
  poller ??= setInterval(() => {
    void tell(Cmd.SETTINGS);
  }, POLL_MS);
}

function stopPolling() {
  if (poller) clearInterval(poller);
  poller = null;
}

/** Connect, and wait for the first height so nothing is measured blind. */
async function open() {
  height = null;
  link = new DeskLink(MAC, log);
  link.on('frame', (f) => {
    if (f.command === Report.HEIGHT) height = readHeight(f.params);
  });
  await link.start();
  if (!link.connected) {
    await new Promise((res) => {
      const t = setTimeout(res, 60_000);
      link.once('connected', () => {
        clearTimeout(t);
        res();
      });
    });
  }
  if (!link.connected) {
    console.error('nicht verbunden — ist das plugin wirklich deaktiviert?');
    process.exit(1);
  }
  await link.send(Cmd.WAKE);
  await sleep(700);
  await link.send(Cmd.SETTINGS);
  await sleep(1200);
}

/** Let go of the dongle: it takes one connection, and the reset needs it. */
async function release() {
  stopPolling();
  await link.close();
  link = null;
  await sleep(1500);
}

async function tell(command, params = []) {
  if (!link?.connected) return false;
  try {
    await link.send(command, params);
    return true;
  } catch (err) {
    say(`    (senden fehlgeschlagen: ${err.message})`);
    return false;
  }
}

/** Wait until the height has not changed for `stillMs`. */
async function settle(stillMs) {
  let still = 0;
  let prev = height;
  while (still < stillMs) {
    await sleep(200);
    if (height !== prev) {
      prev = height;
      still = 0;
    } else {
      still += 200;
    }
  }
}

/** Ask for the settings block; returns a map of field code to value. */
async function readSettings() {
  const got = new Map();
  const on = (f) => {
    if (f.command === Report.HEIGHT || f.command === Cmd.CONNECT) return;
    if (f.params.length === 1) got.set(f.command, f.params[0]);
  };
  link.on('frame', on);
  await tell(Cmd.CONNECT);
  await sleep(1500);
  link.off('frame', on);
  return got;
}

/** Cruise speed from height samples: middle 60% only, without either ramp. */
function cruise(samples, from, to) {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const moving = samples.filter(([, h]) => h > lo + 10 && h < hi - 10);
  if (moving.length < 6) return null;
  const a = moving[Math.floor(moving.length * 0.2)];
  const b = moving[Math.floor(moving.length * 0.8)];
  const secs = (b[0] - a[0]) / 1000;
  return secs > 0 ? Math.abs(b[1] - a[1]) / secs : null;
}

/** Collect height samples while `drive` runs. */
async function record(drive) {
  const samples = [];
  const on = (f) => {
    if (f.command === Report.HEIGHT) samples.push([Date.now(), readHeight(f.params)]);
  };
  link.on('frame', on);
  await drive();
  link.off('frame', on);
  return samples;
}

/** Climb LOW → HIGH on repeated RAISE, the way the app's slider is meant to. */
async function climbStepped() {
  // Only here: nothing streams a height during a step climb.
  startPolling();
  const samples = await record(async () => {
    const deadline = Date.now() + CLIMB_LIMIT_MS;
    // `height === null` is not "not there yet", it is "no idea" — and pulsing
    // on that basis is how this tool once drove the desk into its top stop.
    while (Date.now() < deadline && height !== null && height < HIGH - APPROACH_MM) {
      if (!link?.connected || !(await tell(Cmd.RAISE))) break;
      await sleep(PULSE_MS);
    }
  });
  stopPolling();
  // On one-touch a step command is not necessarily a step: the box may take it
  // as "go", and go. Never leave a climb without saying stop.
  await tell(Cmd.STOP);
  await settle(1500);
  return { samples, speed: cruise(samples, LOW, HIGH - APPROACH_MM) };
}

/**
 * Climb LOW → HIGH on GOTO_HEIGHT, where the box runs its own ramp.
 *
 * Always ends with STOP. On one-touch the box keeps driving to the target long
 * after this process has let go of the dongle, so a tool that simply exits
 * leaves the desk moving with nothing attached to it. That happened once, with
 * the owner standing there watching it, which is one time too many.
 */
async function climbNative() {
  const samples = await record(async () => {
    if (!(await tell(Cmd.GOTO_HEIGHT, heightParams(HIGH)))) return;
    const deadline = Date.now() + CLIMB_LIMIT_MS;
    while (Date.now() < deadline && height !== null && height < HIGH - 5) {
      await sleep(200);
    }
  });
  await tell(Cmd.STOP);
  await settle(1500);
  return { samples, speed: cruise(samples, LOW, HIGH) };
}

/**
 * Drive to `target` and wait until the desk is actually there.
 *
 * The old code fired GOTO_HEIGHT and called `settle()`, which returns as soon
 * as the height holds still for two seconds — including the two seconds before
 * a box under its own power has got going. The next command then arrived
 * mid-move and the desk reversed.
 */
async function goTo(target) {
  if (!(await tell(Cmd.GOTO_HEIGHT, heightParams(target)))) return false;
  const deadline = Date.now() + CLIMB_LIMIT_MS;
  while (Date.now() < deadline) {
    await sleep(250);
    if (height !== null && Math.abs(height - target) <= 10) break;
  }
  await tell(Cmd.STOP);
  await settle(1500);
  return height !== null && Math.abs(height - target) <= 25;
}

/**
 * Both climbs, from the same start, reported the same way.
 *
 * Refuses to drive a desk whose position is unknown. The control box streams
 * `0x04` where the height belongs once it has lost its zero, and an earlier
 * version of this tool took that for "not there yet" and went on pulsing RAISE
 * into the top stop for forty-five seconds. Driving blind is not a measurement
 * and is not safe; the desk has to be reset first.
 */
async function measure(label) {
  const out = {};
  if (height === null) {
    say(`${label}  ABBRUCH: keine hoehe bekannt — die box kennt ihre position nicht.`);
    say(`${label}  (sie sendet 0x04 statt der hoehe; das loest nur ein reset.)`);
    return null;
  }
  for (const [mode, run, back] of [
    ['step      ', climbStepped, true],
    ['GOTO_HEIGHT', climbNative, true],
  ]) {
    if (!(await goTo(LOW))) {
      say(`${label} ${mode}  uebersprungen: kam nicht auf ${LOW} mm`);
      continue;
    }
    const start = height;
    const { samples, speed } = await run();
    const heights = samples.map(([, h]) => h);
    if (heights.length === 0) {
      say(`${label} ${mode}  ABBRUCH: keine hoehenmeldungen — die box kennt ihre position nicht`);
      return null;
    }
    const travelled = Math.max(...heights) - Math.min(...heights);
    if (travelled < 20) {
      say(`${label} ${mode}  ABBRUCH: gemeldet, aber nicht bewegt (kindersicherung? limit?)`);
      return null;
    }
    out[mode.trim()] = speed;
    say(
      `${label} ${mode}  ${speed != null ? speed.toFixed(1).padStart(5) : '    ?'} mm/s` +
        `  (${start} → ${height} mm)`,
    );
    if (back) await sleep(500);
  }
  return out;
}

if (PHASE === 0) {
  // Measure what the desk does right now, changing nothing. What it is set to
  // was decided before the last reset; this only asks what that produced.
  await open();
  const now = await readSettings();
  say(`start ${height} mm, LOW_POWER ${now.get(0x18)}, VELOCITY ${now.get(0x13)}`);
  say('');
  const out = await measure('jetzt   ');
  if (out) {
    say('');
    say('=== ergebnis ===');
    say(`eingestellt: LOW_POWER ${now.get(0x18)}, VELOCITY ${now.get(0x13)}`);
    for (const mode of ['step', 'GOTO_HEIGHT']) {
      const v = out[mode];
      say(`${mode.padEnd(11)}  ${v != null ? `${v.toFixed(1)} mm/s` : 'unvollstaendig'}`);
    }
    say('');
    say('zum vergleich: alle frueheren messungen lagen bei 22.2-22.6 mm/s.');
  }
  stopPolling();
  await link.close();
  process.exit(0);
}

if (PHASE === 1) {
  await open();

  const before = await readSettings();
  say(
    `start ${height} mm, vorgefunden: LOW_POWER ${before.get(0x18)}, VELOCITY ${before.get(0x13)}`,
  );

  // Set the pair, and confirm the box took both before anything is measured.
  await tell(Cmd.LOW_POWER, [ECO]);
  await sleep(300);
  await tell(Cmd.VELOCITY, [velocityArg]);
  await sleep(1200);
  const stored = await readSettings();
  say(`geschrieben: LOW_POWER ${stored.get(0x18)}, VELOCITY ${stored.get(0x13)}`);
  if (stored.get(0x18) !== ECO || stored.get(0x13) !== velocityArg) {
    say('ABBRUCH: die box hat die einstellung nicht uebernommen');
    await link.close();
    process.exit(1);
  }

  // A baseline on the stored-but-not-yet-reset desk. If these already differ
  // from the earlier 22.4 mm/s, the reset is not what made the difference.
  say('');
  say('--- vor dem reset (einstellung gespeichert, noch nicht wirksam) ---');
  const pre = await measure('vorher ');

  writeFileSync(
    STATE,
    JSON.stringify(
      {
        mac: MAC,
        eco: ecoArg,
        ECO,
        velocity: velocityArg,
        found: { lowPower: before.get(0x18), velocity: before.get(0x13) },
        pre,
        at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  await release();

  say('');
  say('======================================================');
  say('JETZT DEN TISCH ZURUECKSETZEN. Der dongle ist frei.');
  say('');
  say('Reset in der Eliot-App (Automatischer Reset) oder am handset:');
  say('der tisch faehrt selbst bis ganz nach unten (~642 mm).');
  say('');
  say('ACHTUNG: die app schreibt beim verbinden ihre eigenen');
  say('gespeicherten werte auf den tisch. phase 2 liest den block');
  say('neu und sagt, was wirklich drinsteht. app danach schliessen.');
  say('');
  say(`danach:  node tools/reset-speed-test.js ${MAC} --phase=2`);
  say('======================================================');
  process.exit(0);
}

// --- phase 2 ---
let state;
try {
  state = JSON.parse(readFileSync(STATE, 'utf8'));
} catch {
  console.error(`kein zustand aus phase 1 gefunden (${STATE}) — erst --phase=1 laufen lassen`);
  process.exit(1);
}

await open();
const after = await readSettings();
say(`nach dem reset: LOW_POWER ${after.get(0x18)}, VELOCITY ${after.get(0x13)}`);
say(`phase 1 hatte gesetzt: LOW_POWER ${state.ECO}, VELOCITY ${state.velocity}`);

const survived = after.get(0x18) === state.ECO && after.get(0x13) === state.velocity;
if (!survived) {
  say('');
  say('die einstellung hat den reset NICHT ueberlebt — vermutlich hat die app sie');
  say('ueberschrieben. die messung laeuft trotzdem, aber sie zaehlt fuer die werte,');
  say('die jetzt wirklich drinstehen, nicht fuer die gewollten.');
}

say('');
say('--- nach dem reset ---');
const post = await measure('nachher');

say('');
say('=== ergebnis ===');
say(
  `gewollt: eco ${state.eco}, VELOCITY ${state.velocity}` +
    (survived ? ' (hat den reset ueberlebt)' : ' — NICHT ueberlebt'),
);
say(`tatsaechlich jetzt: LOW_POWER ${after.get(0x18)}, VELOCITY ${after.get(0x13)}`);
for (const mode of ['step', 'GOTO_HEIGHT']) {
  const a = state.pre?.[mode];
  const b = post?.[mode];
  if (a == null || b == null) {
    say(`${mode.padEnd(11)}  unvollstaendig`);
    continue;
  }
  const d = b - a;
  say(
    `${mode.padEnd(11)}  vorher ${a.toFixed(1)} mm/s → nachher ${b.toFixed(1)} mm/s` +
      `  (${d >= 0 ? '+' : ''}${d.toFixed(1)})`,
  );
}
say('');
say('zum vergleich: alle frueheren messungen lagen bei 22.2-22.6 mm/s.');
say('ein unterschied unter 1 mm/s ist innerhalb dessen, was die rig-streuung hergibt.');

stopPolling();
await tell(Cmd.STOP);
await link.close();
process.exit(0);
