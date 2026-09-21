#!/usr/bin/env node
/**
 * Write one byte of the settings block and read it back.
 * THIS DOES NOT MOVE THE DESK. With --reset it puts the box into RESET mode.
 *
 *   npm run build
 *   node tools/set-setting.js <MAC> --code=0x19 --value=1
 *   node tools/set-setting.js <MAC> --code=0x19 --value=1 --reset
 *
 * The settings block reports what the control box has *stored*, which is not
 * what it is *running*. The two only come together when the desk is reset, and
 * that gap is what made the earlier speed measurements meaningless: velocity 40
 * and velocity 28 were both stored, neither was in force, and the desk moved at
 * 22.4 mm/s either way.
 *
 * So a value written here is a promise about the desk's behaviour *after* its
 * next reset, and this tool says so rather than pretending the write took
 * effect.
 *
 * This header used to blame `MOTION_MODE` (`0x19`) for GOTO_HEIGHT moving the
 * desk 10 mm and stopping: `00` was stored, `00` was read as hold-to-move, and
 * the reset performed here was said to have made it live. Both halves were
 * wrong. `00` is one touch, not hold — see docs/PROTOCOL.md — and the 10 mm
 * was a 400 ms `SETTINGS` poll in the test tools cancelling every move.
 *
 * `--reset` sends `0x91`, which is the entry into reset mode. Verified on this
 * hardware: the handset then shows RESET with a circle, and the reset happens
 * when the *owner* turns the handset left — the desk drives to its bottom, finds
 * its zero and comes back up to the soft minimum. Nothing here can do that part,
 * which is a good place for the boundary to sit: no command in this file moves
 * the desk.
 */
import { DeskLink } from '../dist/eliot/link.js';
import { Cmd, Report, readHeight } from '../dist/eliot/protocol.js';

const MAC = (process.argv[2] || '').toUpperCase();
const args = process.argv.slice(3);
const arg = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const has = (name) => args.includes(`--${name}`);

const CODE = Number(arg('code'));
const VALUE = Number(arg('value'));
const RESET = has('reset');
/** How long to keep the link up after 0x91; see the note where it is sent. */
const HOLD = Number(arg('hold') ?? 45_000);

if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(MAC) || !Number.isInteger(CODE) || !Number.isInteger(VALUE)) {
  console.error('usage: node tools/set-setting.js <MAC> --code=0x19 --value=1 [--reset]');
  console.error('  0x13 velocity   0x18 low power   0x19 motion mode (0 one-touch, 1 halten)');
  console.error('  0x1d sensitivity   0x0e units');
  process.exit(1);
}

const hex = (n) => `0x${n.toString(16).padStart(2, '0')}`;
const t0 = Date.now();
const say = (m) => console.log(`${String((Date.now() - t0) / 1000).padStart(7)}s ${m}`);
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: (m) => say(`ERR ${m}`) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let height = null;
const link = new DeskLink(MAC, log);
link.on('frame', (f) => {
  if (f.command === Report.HEIGHT) height = readHeight(f.params);
  if (f.command === 0x40) say('>>> 0x40 — die box meldet reset-modus');
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

/** Ask for the settings block; returns a map of field code to value. */
async function readSettings() {
  const got = new Map();
  const on = (f) => {
    if (f.command === Report.HEIGHT || f.command === Cmd.CONNECT) return;
    if (f.params.length === 1) got.set(f.command, f.params[0]);
  };
  link.on('frame', on);
  await link.send(Cmd.CONNECT);
  await sleep(1500);
  link.off('frame', on);
  return got;
}

await link.send(Cmd.WAKE);
await sleep(700);
await link.send(Cmd.SETTINGS);
await sleep(1200);

const before = await readSettings();
say(`hoehe ${height === null ? 'unbekannt' : `${height} mm`}`);
say(`vorher:  ${hex(CODE)} = ${before.get(CODE)}`);

await link.send(CODE, [VALUE]);
await sleep(1200);

const after = await readSettings();
say(`nachher: ${hex(CODE)} = ${after.get(CODE)}`);

if (after.get(CODE) !== VALUE) {
  say(`ABBRUCH: die box hat ${VALUE} nicht uebernommen`);
  await link.close();
  process.exit(1);
}

say('');
say(`gespeichert — aber NOCH NICHT WIRKSAM. das wird es erst beim naechsten reset.`);

if (RESET) {
  say('');
  say('sende 0x91 — reset-modus');
  await link.send(0x91);
  await sleep(2000);
  say('');
  say(`halte die verbindung ${HOLD / 1000}s offen.`);
  say('(beim ersten mal lief das kommando in einem tool, das danach noch 20s');
  say(' zuhoerte — ein sofortiger disconnect koennte den modus wieder beenden.)');
  say('');
  say('=== jetzt am handset ===');
  say('das handset sollte RESET und den kreis zeigen.');
  say('nach links drehen: der tisch faehrt runter bis zum anschlag,');
  say('findet seine null und kommt auf das soft-minimum zurueck.');
  say('');
  say('danach ist die einstellung oben scharf.');

  const until = Date.now() + HOLD;
  while (Date.now() < until) {
    await sleep(1000);
    const left = Math.round((until - Date.now()) / 1000);
    if (left % 10 === 0 && left > 0) say(`  ...verbindung offen (${left}s)`);
  }
}

await link.close();
process.exit(0);
