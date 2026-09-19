#!/usr/bin/env node
/**
 * Do VELOCITY and LOW_POWER writes actually land? THIS DOES NOT MOVE THE DESK.
 *
 *   npm run build && node tools/settings-write-test.js <MAC>
 *
 * tools/version-probe.js turned up something the protocol notes had wrong:
 * CONNECT (0xFE) is not a mystery and not decoration. The control box answers
 * it with its entire settings block — velocity, low power, motion mode,
 * sensitivity, collision, units and more — which is why the app brackets
 * configuration commands with it. VERSION (0x1C) on its own answers one byte.
 *
 * That gives us a read-back where docs/PROTOCOL.md assumed there was none, and
 * a much cheaper question than the earlier speed runs asked. Before measuring
 * whether a setting *does* anything, measure whether it is *stored*. A write
 * the box silently drops looks exactly like a setting that has no effect, and
 * the two were never told apart.
 *
 * Each write is tried both bare and inside the CONNECT bracket, because the
 * bracket already proved to matter once.
 */
import { DeskLink } from '../dist/eliot/link.js';
import { Cmd, Report } from '../dist/eliot/protocol.js';

const MAC = (process.argv[2] || '').toUpperCase();
if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(MAC)) {
  console.error('usage: node tools/settings-write-test.js <MAC>');
  process.exit(1);
}

const t0 = Date.now();
const say = (m) => console.log(`${String((Date.now() - t0) / 1000).padStart(7)}s ${m}`);
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: (m) => say(`ERR ${m}`) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The fields worth naming; the rest are printed by code. */
const FIELDS = new Map([
  [0x0e, 'UNITS'],
  [0x13, 'VELOCITY'],
  [0x18, 'LOW_POWER'],
  [0x19, 'MOTION_MODE'],
  [0x1c, 'VERSION'],
  [0x1d, 'SENSITIVITY'],
]);
const name = (code) =>
  (FIELDS.get(code) ?? `0x${code.toString(16).padStart(2, '0')}`).padEnd(11);

const link = new DeskLink(MAC, log);

async function ready(ms = 45_000) {
  if (link.connected) return true;
  say('    (verbindung weg — warte auf reconnect)');
  return new Promise((res) => {
    const t = setTimeout(() => res(false), ms);
    link.once('connected', () => {
      clearTimeout(t);
      res(true);
    });
  });
}

async function tell(command, params = []) {
  if (!(await ready())) return false;
  try {
    await link.send(command, params);
    return true;
  } catch (err) {
    say(`    (senden fehlgeschlagen: ${err.message})`);
    return false;
  }
}

/**
 * Ask for the settings block and parse it.
 *
 * The block arrives as one frame per field. Height reports are filtered out;
 * so is the CONNECT echo, which carries nothing.
 */
async function readSettings() {
  const got = new Map();
  const on = (f) => {
    if (f.command === Report.HEIGHT || f.command === Cmd.CONNECT) return;
    got.set(f.command, f.params.length === 1 ? f.params[0] : Buffer.from(f.params).toString('hex'));
  };
  link.on('frame', on);
  await tell(Cmd.CONNECT);
  await sleep(1500);
  link.off('frame', on);
  return got;
}

/** Print only what changed between two reads — the whole point of the exercise. */
function diff(before, after) {
  const codes = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a - b);
  const changed = codes.filter((c) => before.get(c) !== after.get(c));
  if (changed.length === 0) {
    say('    unveraendert — der schreibzugriff kam nicht an');
    return false;
  }
  for (const c of changed) {
    say(`    ${name(c)} ${String(before.get(c))} -> ${String(after.get(c))}`);
  }
  return true;
}

await link.start();
if (!(await ready(60_000))) {
  console.error('nicht verbunden — laeuft das Plugin noch?');
  process.exit(1);
}
await tell(Cmd.WAKE);
await sleep(700);

const baseline = await readSettings();
say('ausgangslage:');
for (const [code, value] of [...baseline].sort((a, b) => a[0] - b[0])) {
  say(`    ${name(code)} ${value}`);
}

/** Write, re-read, and say whether the box kept it. */
async function attempt(label, command, value, bracketed) {
  const before = await readSettings();
  if (bracketed) {
    await tell(Cmd.CONNECT);
    await sleep(150);
  }
  await tell(command, [value]);
  await sleep(150);
  if (bracketed) await tell(Cmd.CONNECT);
  await sleep(1200);

  const after = await readSettings();
  say(`${label}:`);
  return diff(before, after);
}

const velocity = baseline.get(0x13);
const lowPower = baseline.get(0x18);
// Pick a velocity that differs from the current one, or nothing can be seen.
const tryVelocity = velocity === 40 ? 28 : 40;

await attempt(`VELOCITY ${tryVelocity}, blank`, Cmd.VELOCITY, tryVelocity, false);
await attempt(`VELOCITY ${tryVelocity}, CONNECT-geklammert`, Cmd.VELOCITY, tryVelocity, true);
await attempt(`LOW_POWER ${lowPower ? 0 : 1}, blank`, Cmd.LOW_POWER, lowPower ? 0 : 1, false);
await attempt(
  `LOW_POWER ${lowPower ? 0 : 1}, CONNECT-geklammert`,
  Cmd.LOW_POWER,
  lowPower ? 0 : 1,
  true,
);

// Put back what was found, bracketed — by now the bracket is the way that works.
say('zuruecksetzen auf die ausgangslage:');
await tell(Cmd.CONNECT);
await sleep(150);
await tell(Cmd.VELOCITY, [velocity]);
await sleep(300);
await tell(Cmd.LOW_POWER, [lowPower]);
await sleep(150);
await tell(Cmd.CONNECT);
await sleep(1200);

const restored = await readSettings();
const ok = restored.get(0x13) === velocity && restored.get(0x18) === lowPower;
say(
  ok
    ? `    wiederhergestellt: VELOCITY ${velocity}, LOW_POWER ${lowPower}`
    : `    ACHTUNG: steht jetzt auf VELOCITY ${restored.get(0x13)}, LOW_POWER ${restored.get(0x18)}` +
        `, nicht auf ${velocity}/${lowPower}`,
);

await link.close();
process.exit(0);
