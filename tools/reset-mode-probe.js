#!/usr/bin/env node
/**
 * Can the control box be put into RESET mode over this port?
 * THIS DOES NOT MOVE THE DESK.
 *
 *   npm run build && node tools/reset-mode-probe.js <MAC> [--cmd=0x91]
 *
 * The desk's owner describes the real procedure: something puts the box into
 * reset mode, the handset then shows *RESET* and a circle asking for a turn to
 * the left, and only that manual turn drives the desk down and re-homes it. So
 * the part worth finding is the *entry* into reset mode — the rest is the
 * owner's hands, and does not need us.
 *
 * Two candidates, both already in docs/PROTOCOL.md:
 *
 *   - `0x91 CALIBRATE`, from the Jarvis notes: "desk must be at its lowest.
 *     Leaves the desk in RESET mode". It was written off here because it never
 *     appears in the app's own traffic, which is evidence about the app and not
 *     about the box.
 *   - `0x40`, which is listed as the *report* meaning "control box in RESET
 *     mode". The settings block sets the precedent for a report reusing the
 *     code of the command that causes it, so `0x40` is worth one frame too.
 *
 * The box streams `0x04` where the height belongs once it has lost its zero,
 * and this tool is meant to be usable in exactly that state, so a silent reply
 * is not treated as failure — the handset is the real display here. Watch it.
 *
 * Nothing here drives the desk. The only command sent is the one named.
 */
import { DeskLink } from '../dist/eliot/link.js';
import { Cmd, Report, readHeight } from '../dist/eliot/protocol.js';

const MAC = (process.argv[2] || '').toUpperCase();
const args = process.argv.slice(3);
const arg = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

const CMD = Number(arg('cmd') ?? 0x91);
const LISTEN_MS = Number(arg('listen') ?? 20_000);

if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(MAC) || !Number.isInteger(CMD)) {
  console.error('usage: node tools/reset-mode-probe.js <MAC> [--cmd=0x91] [--listen=20000]');
  process.exit(1);
}

const hex = (n) => `0x${n.toString(16).padStart(2, '0')}`;
const t0 = Date.now();
const say = (m) => console.log(`${String((Date.now() - t0) / 1000).padStart(7)}s ${m}`);
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: (m) => say(`ERR ${m}`) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every frame, counted by code: the interesting one may only arrive once. */
const seen = new Map();
let height = null;

const link = new DeskLink(MAC, log);
link.on('frame', (f) => {
  seen.set(f.command, (seen.get(f.command) ?? 0) + 1);
  if (f.command === Report.HEIGHT) height = readHeight(f.params);
  // 0x40 is the whole point; print it the moment it appears rather than in the
  // summary, so it can be matched against what the handset is doing.
  if (f.command === 0x40) {
    say(`>>> 0x40 RESET — die box meldet reset-modus  (params ${f.params.toString('hex') || '-'})`);
  }
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

async function tell(command, params = []) {
  try {
    await link.send(command, params);
    return true;
  } catch (err) {
    say(`senden fehlgeschlagen: ${err.message}`);
    return false;
  }
}

await tell(Cmd.WAKE);
await sleep(700);
await tell(Cmd.SETTINGS);
await sleep(1200);
say(`vorher: hoehe ${height === null ? 'unbekannt' : `${height} mm`}`);

const before = new Map(seen);

say('');
say(`sende ${hex(CMD)} — JETZT AUFS HANDSET SCHAUEN`);
say('erwartet, falls es das richtige kommando ist: RESET und der kreis');
say('');
await tell(CMD);

// Listen without sending anything else: a poll would muddy which frames are
// answers to this command and which are answers to the poll.
const until = Date.now() + LISTEN_MS;
while (Date.now() < until) {
  await sleep(1000);
  const secs = Math.round((Date.now() - t0) / 1000);
  if (secs % 5 === 0) say(`  ...horcht (${Math.round((until - Date.now()) / 1000)}s)`);
}

say('');
say('=== frames waehrend der beobachtung ===');
let anythingNew = false;
for (const [code, count] of [...seen].sort((a, b) => a[0] - b[0])) {
  const delta = count - (before.get(code) ?? 0);
  if (delta > 0) {
    anythingNew = true;
    say(`  ${hex(code)}  ${delta}x`);
  }
}
if (!anythingNew) say('  (keine)');

say('');
if (seen.has(0x40)) {
  say('0x40 gesehen — das kommando bringt die box in den reset-modus.');
} else {
  say(`kein 0x40. das heisst nicht zwingend nein: wenn das handset RESET zeigt,`);
  say(`hat ${hex(CMD)} funktioniert und die box meldet es nur nicht ueber diesen port.`);
  say('was zeigt das handset?');
}

await link.close();
process.exit(0);
