#!/usr/bin/env node
/**
 * Put the child lock into a given state. THIS DOES NOT MOVE THE DESK.
 *
 *   npm run build && node tools/set-lock.js <MAC> on|off
 *
 * 0x1F is a toggle, not a setting, so getting to a *state* means reading first
 * and only flipping when the reading disagrees. Sending the toggle blindly
 * would unlock a locked desk half the time and lock an unlocked one the other
 * half. Both the query and the toggle answer with the state afterwards, so
 * nothing here has to be assumed.
 */
import { DeskLink } from '../dist/eliot/link.js';
import { Cmd, Report } from '../dist/eliot/protocol.js';

const MAC = (process.argv[2] || '').toUpperCase();
const WANT = (process.argv[3] || '').toLowerCase();
if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(MAC) || !['on', 'off'].includes(WANT)) {
  console.error('usage: node tools/set-lock.js <MAC> on|off');
  process.exit(1);
}
const want = WANT === 'on' ? 1 : 0;

const t0 = Date.now();
const say = (m) => console.log(`${String((Date.now() - t0) / 1000).padStart(7)}s ${m}`);
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: (m) => say(`ERR ${m}`) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const link = new DeskLink(MAC, log);

async function ready(ms = 60_000) {
  if (link.connected) return true;
  return new Promise((res) => {
    const t = setTimeout(() => res(false), ms);
    link.once('connected', () => {
      clearTimeout(t);
      res(true);
    });
  });
}

/**
 * Send a LOCK frame and return the state it answers with, or undefined.
 *
 * Undefined means no answer arrived, which is not the same as unlocked and
 * must never be printed as one. An earlier version of this tool did exactly
 * that and reported a desk it had never heard from as successfully unlocked.
 */
async function lock(param, wait = 3000) {
  let state;
  const on = (f) => {
    if (f.command === Report.LOCK) state = f.params[0];
  };
  link.on('frame', on);
  await link.send(Cmd.LOCK, [param]);
  await sleep(wait);
  link.off('frame', on);
  return state;
}

const shown = (s) => (s === undefined ? 'KEINE ANTWORT' : s ? 'AN' : 'AUS');

await link.start();
if (!(await ready())) {
  console.error('nicht verbunden — laeuft das Plugin noch?');
  process.exit(1);
}

// The control box ignores plenty when it has gone quiet, and a toggle that is
// ignored is indistinguishable from one that was refused. Wake it first.
await link.send(Cmd.WAKE);
await sleep(800);

const before = await lock(0x00);
say(`kindersicherung ist ${shown(before)}`);
if (before === undefined) {
  console.error('keine antwort auf die abfrage — nichts umgeschaltet');
  process.exit(1);
}

if (before === want) {
  say(`steht schon auf ${WANT} — nichts zu tun`);
} else {
  const answer = await lock(0x01);
  say(`umschalten beantwortet mit: ${shown(answer)}`);

  // Do not trust the toggle's own answer: ask again, from scratch.
  let after = await lock(0x00);
  say(`nachgefragt: ${shown(after)}`);

  // CONNECT turned out to be what makes the box hand over its settings block,
  // so it is worth one try as a bracket here too before giving up.
  if (after !== want) {
    say('zweiter versuch, in der CONNECT-klammer:');
    await link.send(Cmd.CONNECT);
    await sleep(300);
    await lock(0x01, 2000);
    await link.send(Cmd.CONNECT);
    await sleep(800);
    after = await lock(0x00);
    say(`    nachgefragt: ${shown(after)}`);
  }

  if (after !== want) {
    console.error(`FEHLGESCHLAGEN: wollte ${WANT}, steht auf ${shown(after)}`);
    await link.close();
    process.exit(1);
  }
  say(`kindersicherung ist jetzt ${WANT}`);
}

await link.close();
process.exit(0);
